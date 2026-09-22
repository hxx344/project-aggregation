import { useCallback, useEffect, useState } from 'react';
import ProjectPage from './ProjectPage';
import { projectKey, retainedProjects } from './hub-state';
import type { NavigationQuery } from './hub-state';
import type { Project } from './types';

export default function ProjectWorkspace({ projects, activeId, query, onEdit, onExpired, onChanged, onNavigate }: {
  projects: Project[]; activeId: string | null; query?: NavigationQuery;
  onEdit: (project: Project) => void; onExpired: () => void; onChanged: (id: string) => void;
  onNavigate: (id: string, query: NavigationQuery) => void;
}) {
  const [visited, setVisited] = useState<string[]>([]);
  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const retained = retainedProjects(visited, projects, activeId, ready);
  const signature = JSON.stringify(retained);
  useEffect(() => { setVisited(previous => JSON.stringify(previous) === signature ? previous : JSON.parse(signature)); }, [signature]);
  const onReady = useCallback((key: string, value: boolean) => setReady(previous => {
    if (previous.has(key) === value) return previous;
    const next = new Set(previous); if (value) next.add(key); else next.delete(key); return next;
  }), []);
  // Revisions disappear on config edits/removal; neither their frames nor capabilities survive.
  const revisions = projects.map(projectKey).join('|');
  useEffect(() => { const live = new Set(revisions.split('|')); setReady(previous => [...previous].every(key => live.has(key)) ? previous : new Set([...previous].filter(key => live.has(key)))); }, [revisions]);
  // MRU chooses eviction only. Reordering iframe DOM nodes reloads them in Chrome,
  // which also consumes their single-use authorization URL a second time.
  return <>{projects.filter(project => retained.includes(projectKey(project))).map(project => {
    const key = projectKey(project);
    return <ProjectPage key={key} project={project} active={project.id === activeId} query={project.id === activeId ? query : undefined} onEdit={() => onEdit(project)} onExpired={onExpired} onReady={value => onReady(key, value)} onChanged={() => onChanged(project.id)} onNavigate={onNavigate} />;
  })}</>;
}
