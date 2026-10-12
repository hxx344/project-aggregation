import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, validateConfig } from "./alert-engine.mjs";

export const initialState = () => ({
  version: 1, revision: 0, config: structuredClone(DEFAULT_CONFIG), ruleStates: {}, history: [],
  status: { checkedAt: null, lastSuccessAt: null, lastError: "", lastQuote: null }, lastTestAt: null,
});

export async function openStore(directory) {
  const file = resolve(directory, "alerts.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (![1, 2].includes(state.version) || !Number.isInteger(state.revision) || !Array.isArray(state.history) || !state.ruleStates || !state.status) throw new Error("Invalid state");
    state.config = validateConfig(state.config, undefined, { requireWebhook: state.version === 1 });
    for (const value of Object.values(state.ruleStates)) {
      if (typeof value.armed !== "boolean" || ![value.lastSentAt, value.lastAttemptAt].every(time => time === null || (Number.isFinite(time) && time >= 0))) throw new Error("Invalid rule state");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`无法读取告警状态文件 ${file}，请修复文件或从备份恢复。`, { cause: error });
    state = initialState();
  }
  let writing = Promise.resolve();
  return {
    get: () => structuredClone(state),
    save(next) {
      const snapshot = structuredClone(next);
      const operation = writing.then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, file);
        state = snapshot;
      });
      writing = operation.catch(() => {});
      return operation;
    },
  };
}
