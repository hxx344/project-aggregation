import { moduleOrigin } from './transport.mjs';

const declarations = {
  monitor: { summaryVersions: [1, 2], healthPath: '/healthz', maintenanceVersion: null, updateStatusVersion: null },
  asset: { summaryVersions: [2], healthPath: '/api/health', maintenanceVersion: null, updateStatusVersion: null },
  crossex: { summaryVersions: [1, 2], healthPath: '/api/health', maintenanceVersion: 1, updateStatusVersion: 1 },
  greeks: { summaryVersions: [2], healthPath: '/api/health', maintenanceVersion: 1, updateStatusVersion: 1 },
  aster: { summaryVersions: [2], healthPath: '/api/health', maintenanceVersion: 1, updateStatusVersion: 1 },
};

export function moduleCapabilities(id) {
  if (!Object.hasOwn(declarations, id)) throw new Error('Unknown embedded module');
  return { schemaVersion: 1, moduleId: id, ...structuredClone(declarations[id]), readinessVersion: null, accountWriterVersion: ['crossex', 'greeks', 'aster'].includes(id) ? 1 : null };
}

function matches(value, expected) {
  if (expected === null || typeof expected !== 'object') return value === expected;
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => matches(value[index], item));
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every(key => Object.hasOwn(value, key) && matches(value[key], expected[key]));
}

export async function readModuleCapabilities(id, { request, deadline = Date.now() + 5000, signal } = {}) {
  const expected = moduleCapabilities(id);
  const { data } = await request(moduleOrigin(id), '/__workspace/capabilities', { deadline, signal, limit: 16 * 1024 });
  if (!matches(data, expected)) throw new Error('Incompatible module capabilities');
  return expected;
}
