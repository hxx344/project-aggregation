import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('cash-flow and local diagnostics routes authenticate first; annotation writes require mutation-origin checks', async () => {
  let authorized = false, reads = 0, writes = 0, databaseCalls = 0;
  const authModes: boolean[] = [], globals = globalThis as unknown as Record<string, unknown>, key = '__cashFlowRoutes';
  globals[key] = {
    apiOwner: async (_request: Request, mutation = false) => { authModes.push(mutation); if (!authorized) throw new Error('AUTH_REQUIRED'); return 'fixture-owner'; },
    json: (value: unknown) => Response.json(value), failure: () => Response.json({}, { status: 401 }), jsonBody: (request: Request) => request.json(),
    db: () => { databaseCalls++; return {}; },
    loadCashFlows: async (_db: unknown, owner: string) => { assert.equal(owner, 'fixture-owner'); reads++; return []; },
    saveCashFlow: async (_db: unknown, owner: string, body: unknown) => { assert.equal(owner, 'fixture-owner'); assert.deepEqual(body, { revision: 0 }); writes++; return []; },
    hubFillsService: { diagnostics: async (_db: unknown, owner: string) => { assert.equal(owner, 'fixture-owner'); reads++; return { groups: [] }; } },
  };
  try {
    const load = async (file: string) => {
      const source = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/^import\s+\{([^}]+)\}\s+from\s+[^;]+;/gm, (_match, names) => `const {${names}} = globalThis.${key};`);
      return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
    };
    const cash = await load('../app/api/cash-flows/route.ts'), diagnostics = await load('../app/api/hub/fills/diagnostics/route.ts');
    const request = () => new Request('https://fixture.local/api/cash-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"revision":0}' });
    assert.equal((await cash.GET(request())).status, 401); assert.equal((await cash.POST(request())).status, 401); assert.equal((await diagnostics.GET(request())).status, 401);
    assert.equal(databaseCalls, 0); assert.equal(reads + writes, 0);
    authorized = true;
    assert.equal((await cash.POST(request())).status, 200); assert.equal(writes, 1); assert.equal(authModes.at(-1), true);
    assert.equal((await diagnostics.GET(request())).status, 200); assert.equal(reads, 1); assert.equal(writes, 1);
  } finally { delete globals[key]; }
});
