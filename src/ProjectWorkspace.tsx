import { useCallback, useEffect, useRef, useState } from 'react';
import ProjectPage from './ProjectPage';
import { emptyWorkspacePlan, planWorkspace, projectKey } from './hub-state';
import type { FramePhase, NavigationQuery } from './hub-state';
import type { Project } from './types';

export default function ProjectWorkspace({ projects, activeId, priorityId = null, query, onEdit, onExpired, onChanged, onNavigate }: {
  projects: Project[]; activeId: string | null; priorityId?: string | null; query?: NavigationQuery;
  onEdit: (project: Project) => void; onExpired: () => void; onChanged: (id: string) => void;
  onNavigate: (id: string, query: NavigationQuery) => void;
}) {
  const [plan, setPlan] = useState(emptyWorkspacePlan);
  const [allowPreload, setAllowPreload] = useState(false);
  const latest = useRef({ projects, activeId, priorityId, allowPreload });
  latest.current = { projects, activeId, priorityId, allowPreload };
  const revisions = projects.map(projectKey).join('|');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer); setAllowPreload(false);
      if (!document.hidden && navigator.onLine) timer = setTimeout(() => setAllowPreload(true), 200);
    };
    update(); document.addEventListener('visibilitychange', update); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    const current = latest.current;
    setPlan(previous => planWorkspace(previous, current.projects, current.activeId, current.priorityId, current.allowPreload));
  }, [revisions, activeId, priorityId, allowPreload]);
  const onStatus = useCallback((key: string, phase: FramePhase) => {
    setPlan(previous => {
      if (!previous.frames.some(frame => frame.key === key && frame.phase !== phase)) return previous;
      const next = { ...previous, frames: previous.frames.map(frame => frame.key === key ? { ...frame, phase } : frame) };
      const current = latest.current;
      return planWorkspace(next, current.projects, current.activeId, current.priorityId, current.allowPreload);
    });
  }, []);
  return <>{plan.frames.map(frame => {
    const project = projects.find(project => projectKey(project) === frame.key);
    if (!project || (!project.enabled && project.id !== activeId)) return null;
    return <ProjectPage key={frame.key} project={project} active={project.id === activeId} query={project.id === activeId ? query : undefined} onEdit={() => onEdit(project)} onExpired={onExpired} onStatus={phase => onStatus(frame.key, phase)} onChanged={() => onChanged(project.id)} onNavigate={onNavigate} />;
  })}</>;
}
