import { z } from 'zod';
import { apiOwner, failure, json, jsonBody } from '@/lib/api';
import { createVariationalDiagnosticGate, diagnoseVariational } from '@/lib/variational-diagnostics';
import { diagnoseVariationalPython } from '@/lib/variational-python-diagnostics';

const inputSchema = z.object({ vrToken: z.string().trim().min(5).max(4096).regex(/^[A-Za-z0-9._~-]+$/) }).strict();
const gate = createVariationalDiagnosticGate();

export async function POST(request: Request) {
  try {
    const owner = await apiOwner(request, true);
    const input = inputSchema.parse(await jsonBody(request));
    const release = gate.claim(owner);
    if (!release) return json({ error: '测试请求过于频繁，请等待 30 秒后重试' }, 429);
    try {
      const checkedAt = new Date().toISOString();
      const clients = await Promise.all([
        diagnoseVariational(input, fetch, request.signal), diagnoseVariationalPython(input, request.signal),
      ]);
      return json({ checkedAt, clients });
    }
    finally { release(); }
  } catch (error) { return failure(error); }
}
