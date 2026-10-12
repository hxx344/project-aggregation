import { timingSafeEqual } from 'node:crypto';

export function workspaceExportAuthorized(headers: Pick<Headers, 'get'>, environment: NodeJS.ProcessEnv = process.env) {
  const expected = environment.ASSET_WORKSPACE_EXPORT_SECRET;
  const supplied = headers.get('x-workspace-asset-export');
  if (environment.WORKSPACE_MANAGED !== '1' || !expected || expected.length < 12 || !supplied) return false;
  const actual = Buffer.from(supplied), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
