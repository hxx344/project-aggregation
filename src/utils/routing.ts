import { navigationQuery } from '../hub-state';
import type { NavigationQuery } from '../hub-state';

export type Route = { view: 'overview' | 'projects' | 'project' | 'trading'; id: string; query?: NavigationQuery };

export function readRoute(): Route {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const query = Object.fromEntries(['symbol', 'longExchange', 'shortExchange'].filter(key => params.has(key)).map(key => [key, params.get(key)]));
  return { view: view === 'projects' || view === 'project' || view === 'trading' ? view : 'overview', id: params.get('id') || '', ...(Object.keys(query).length && navigationQuery(query) ? { query: navigationQuery(query)! } : {}) };
}
