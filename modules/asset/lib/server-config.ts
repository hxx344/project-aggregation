import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ServerConfig = { credentialKey: string; sessionSecret: string; passwordHash: string };
export function serverConfig(): ServerConfig {
  const value = JSON.parse(readFileSync(resolve(process.env.ASSET_DATA_DIR || '.data', 'config.json'), 'utf8')) as ServerConfig;
  if (!/^[a-f0-9]{64}$/i.test(value.credentialKey) || !/^[a-f0-9]{64}$/i.test(value.sessionSecret)
    || !/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(value.passwordHash)) throw new Error('服务器配置无效');
  return value;
}
