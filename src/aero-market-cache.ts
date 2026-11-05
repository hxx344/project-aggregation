// Aero 市场的浏览器本地缓存（IndexedDB）：打开页面先显示上次读到的快照与样本，再向服务器更新。
// 只是加速显示的副本：读写失败、超时或过期都当作没有缓存，页面照常从服务器读取。
const DB_NAME = 'aero-market-cache';
const STORE = 'entries';
const SCHEMA = 1;
// 超过一周的缓存不再展示：数据太旧，不如等服务器。
const MAX_AGE_MS = 7 * 86_400_000;
// IndexedDB 偶尔会卡住（被别的标签页的升级阻塞、隐私模式），不能拖住首屏的服务器读取。
const TIMEOUT_MS = 1500;

type Entry<T> = { schema: number; savedAt: number; data: T };

let opening: Promise<IDBDatabase | null> | null = null;

function withTimeout<T>(work: Promise<T>, fallback: T, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { onTimeout?.(); resolve(fallback); }, TIMEOUT_MS);
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  // 每次打开各自记录是否已超时：重开后迟到的旧连接也能被关掉。
  let timedOut = false;
  opening = withTimeout(new Promise<IDBDatabase | null>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => {
        const db = request.result;
        // 超时后才打开的连接没人用，关掉；别的标签页要升级或连接被关时让出，下次重新打开。
        if (timedOut) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }), null, () => { timedOut = true; }).then((db) => { if (!db) opening = null; return db; });
  return opening;
}

export async function readCache<T>(key: string): Promise<{ savedAt: number; data: T } | null> {
  const db = await open();
  if (!db) return null;
  return withTimeout(new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as Entry<T> | undefined;
        const fresh = entry && entry.schema === SCHEMA && Number.isFinite(entry.savedAt) && Date.now() - entry.savedAt < MAX_AGE_MS;
        // 过期或旧格式的副本同样删除：旧版缓存可能含节点回显的 RPC 密钥，不展示也不应留在本机。
        if (entry && !fresh) store.delete(key);
        resolve(fresh ? { savedAt: entry.savedAt, data: entry.data } : null);
      };
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  }), null);
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  const db = await open();
  if (!db) return;
  await withTimeout(new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ schema: SCHEMA, savedAt: Date.now(), data } satisfies Entry<T>, key);
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
    } catch { resolve(); }
  }), undefined);
}

export async function clearCache(): Promise<void> {
  const db = await open();
  if (!db) return;
  await withTimeout(new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
    } catch { resolve(); }
  }), undefined);
}
