import { createHash } from 'node:crypto';
import { HttpError } from '../http-common.mjs';
import { moduleCatalog, moduleIds } from '../modules/catalog.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// The public view of project rows. The API and the runtime both build it from
// the Hub database; only the API writes the rows and module preferences.
// `decrypt` is needed only for the legacy external-project composition.
export function createProjectCatalog({ control, embeddedModules, decrypt = null }) {
  const { getSetting, projects } = control;
  const publicProject = row => { const project = JSON.parse(row.json);
    if (embeddedModules) {
      const module = moduleCatalog.find(item => item.id === project.id);
      if (!module) return null;
      const preferences = JSON.parse(getSetting('module-preferences:' + module.id) || '{}');
      return { ...module, ...preferences, revision: hash(JSON.stringify([module, preferences])) };
    }
    const credentials = decrypt(row.credentials); return { authOrigin: '', accessMode: ['aster', 'monitor', 'asset'].includes(project.adapter) ? 'proxy' : 'direct', autoSync: project.adapter === 'asset', ...project, revision: hash(`${row.json}\0${row.credentials || ''}`), hasCredentials: !!credentials?.password, ...(credentials?.username ? { username: credentials.username } : {}) }; };
  const getProjects = () => projects.all().map(publicProject).filter(Boolean).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const rowFor = id => { if (embeddedModules && !moduleIds.includes(id)) throw new HttpError(404, '模块已移除'); const row = projects.get(id); if (!row) throw new HttpError(404, '项目不存在'); return row; };
  const projectRevision = id => { if (embeddedModules) return getProjects().find(item => item.id === id)?.revision || null; const row = projects.get(id); return row ? hash(`${row.json}\0${row.credentials || ''}`) : null; };
  return { publicProject, getProjects, rowFor, projectRevision };
}
