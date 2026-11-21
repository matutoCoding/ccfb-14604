/**
 * IndexedDB 持久化:滩田布局、气象潮位、仿真结果、调度计划分 store 存放。
 * 所有写操作幂句(以固定 key upsert),读取失败回退到内存默认。
 */

const DB_NAME = 'saltpan-sim-db';
const DB_VERSION = 1;
const STORES = {
  field: 'field', // 滩田布局与初始状态
  season: 'season', // 气象/潮位
  results: 'results', // 仿真结果快照(按 runId)
  plans: 'plans', // 收盐/闸门计划
  settings: 'settings', // 配置
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async put(store: keyof typeof STORES, key: string, value: unknown): Promise<void> {
    await tx(STORES[store], 'readwrite', (s) => s.put(value, key));
  },
  async get<T>(store: keyof typeof STORES, key: string): Promise<T | undefined> {
    return tx(STORES[store], 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  async keys(store: keyof typeof STORES): Promise<string[]> {
    return tx(STORES[store], 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>).then((ks) =>
      ks.map((k) => String(k)),
    );
  },
  async remove(store: keyof typeof STORES, key: string): Promise<void> {
    await tx(STORES[store], 'readwrite', (s) => s.delete(key));
  },
  async clear(store: keyof typeof STORES): Promise<void> {
    await tx(STORES[store], 'readwrite', (s) => s.clear());
  },
};

/** 结构化克隆可序列化的仿真结果(去掉 TypedArray 之外的函数,全部转普通数组) */
export function serializeResult(result: {
  ledger: unknown;
  harvests: unknown;
  history: Map<number, unknown>;
  trackedCells: number[];
  hours: number;
  backend?: string;
  elapsedMs?: number;
}) {
  return {
    ledger: result.ledger,
    harvests: result.harvests,
    history: Array.from(result.history.entries()).map(([id, rec]) => ({ id, records: rec })),
    trackedCells: result.trackedCells,
    hours: result.hours,
    backend: result.backend,
    elapsedMs: result.elapsedMs,
    savedAt: new Date().toISOString(),
  };
}

export function deserializeHistory(raw: { id: number; records: unknown }[]): Map<number, unknown[]> {
  return new Map(raw.map((r) => [r.id, r.records as unknown[]]));
}

export const STORAGE_KEYS = {
  field: 'current-field',
  season2025: 'season-2025',
  season2024: 'season-2024',
  settings: 'sim-settings',
  plan: 'harvest-plan',
} as const;
