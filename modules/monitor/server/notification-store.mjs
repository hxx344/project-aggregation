import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateWebhook } from "./oil/feishu.mjs";

export function validateChannel(input) {
  if (!input || typeof input.webhookUrl !== "string" || typeof input.signingSecret !== "string" || input.signingSecret.length > 512) throw new Error("飞书机器人配置格式不正确。");
  return { webhookUrl: validateWebhook(input.webhookUrl.trim()), signingSecret: input.signingSecret.trim() };
}

export function initialNotifications(sources = []) {
  const candidates = sources.filter(source => source.webhookUrl).map(source => ({ id: source.id, ...validateChannel(source) }));
  const unique = new Set(candidates.map(({ webhookUrl, signingSecret }) => JSON.stringify([webhookUrl, signingSecret])));
  return {
    version: 1, revision: 0,
    config: unique.size === 1 ? validateChannel(candidates[0]) : { webhookUrl: "", signingSecret: "" },
    candidates: unique.size > 1 ? candidates : [],
    migratedFrom: unique.size === 1 ? candidates.map(source => source.id) : [],
    lastTestAt: null, testResult: null,
  };
}

// Only a missing file permits migration. A deliberately empty configuration is authoritative.
export async function openNotificationStore(directory, sources = () => []) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "notifications.json");
  let state, missing = false;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.candidates) || !Array.isArray(state.migratedFrom) || !(state.lastTestAt === null || Number.isFinite(state.lastTestAt))) throw new Error("Invalid notification state");
    state.config = validateChannel(state.config);
    if (state.candidates.length > 2 || (state.config.webhookUrl && state.candidates.length)) throw new Error("Invalid migration state");
    const ids = new Set();
    state.candidates = state.candidates.map(source => {
      if (!["oil", "hynix"].includes(source.id) || ids.has(source.id)) throw new Error("Invalid migration source");
      ids.add(source.id); return { id: source.id, ...validateChannel(source) };
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取统一飞书配置，请检查 notifications.json 或从备份恢复。", { cause: error });
    state = initialNotifications(await sources()); missing = true;
  }
  let queue = Promise.resolve();
  const store = {
    get: () => structuredClone(state),
    save(value) {
      const snapshot = structuredClone(value);
      const operation = queue.then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
          await rename(temporary, file); state = snapshot;
        } finally { await unlink(temporary).catch(() => {}); }
      });
      queue = operation.catch(() => {}); return operation;
    },
  };
  if (missing) await store.save(state);
  return store;
}
