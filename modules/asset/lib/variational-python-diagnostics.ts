import { spawn } from 'node:child_process';
import { runVariationalPython } from './variational-python-client.ts';
import type { VariationalCredential } from './variational-shared.ts';
import type { VariationalDiagnosticReport } from './variational-diagnostic-types.ts';

export async function diagnoseVariationalPython(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<VariationalDiagnosticReport> {
  const checkedAt = new Date().toISOString();
  const responses = await Promise.all([
    runVariationalPython(c, 'diagnose-session', signal, launch),
    runVariationalPython(c, 'diagnose-portfolio', signal, launch),
  ]);
  return { checkedAt, client: 'grid-python', results: responses.map(response => response.result) };
}
