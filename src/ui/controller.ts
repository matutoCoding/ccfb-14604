/**
 * 仿真运行控制器:统一调 runner,采集 6 小时快照供时间轴回放,结果落 IndexedDB。
 */
import { store, LiveSnapshot } from '../state/store';
import { runSimulation } from '../sim/runner';
import { idb, serializeResult, STORAGE_KEYS } from '../db/idb';
import { toast } from './dom';

export interface RunHandle {
  snapshots: LiveSnapshot[];
  promise: Promise<void>;
}

export async function runFullSeason(onProgress?: (pct: number, hour: number) => void): Promise<RunHandle> {
  const snapshots: LiveSnapshot[] = [];
  const cfg = {
    ...store.settings,
    gateOverride: store.gateOverride.size ? store.gateOverride : undefined,
    harvestPlan: store.harvestPlan.size ? store.harvestPlan : undefined,
    snapshotEvery: 6,
  };
  const tracked = store.crystalCells.map((c) => c.id);

  const handle: RunHandle = { snapshots, promise: Promise.resolve() };
  setLastHandle(handle); // 立即登记,保证时间轴在运行中也能读到已产生的快照
  // CPU 路径在结束时一次回调;GPU 路径每 6 小时回调。统一在 onHour 收集。
  const promise = (async () => {
    const result = await runSimulation(store.layout, store.init, store.season, cfg, {
      trackedCells: tracked,
      forceCpu: store.settings.forceCpu,
      onHour: (snap) => {
        snapshots.push({
          hour: snap.hour,
          depth: snap.depth as Float64Array,
          dsalt: snap.dsalt as Float64Array,
          ssalt: snap.ssalt as Float64Array,
          flags: snap.flags,
        });
        onProgress?.(Math.min(99, (snap.hour / store.season.weather.length) * 100), snap.hour);
      },
    });
    store.result = result;
    store.live = snapshots[snapshots.length - 1] ?? null;
    store.currentHour = result.hours - 1;
    onProgress?.(100, result.hours - 1);
    // 持久化(失败不阻断)
    try {
      await idb.put('results', `run-${store.season.startDate}`, serializeResult(result as never));
      await store.persist();
    } catch (e) {
      console.warn('结果持久化失败', e);
    }
    store.emit();
    toast(`仿真完成:${result.backend === 'webgpu' ? 'WebGPU' : 'CPU'} 后端,盐账误差 ${(result.ledger.relErr * 1000).toFixed(3)}‰`);
  })();
  handle.promise = promise;
  return handle;
}

/** 时间轴按比例取最近快照 */
export function snapshotAt(hour: number): LiveSnapshot | null {
  if (!lastHandle) return store.live;
  const arr = lastHandle.snapshots;
  if (!arr.length) return null;
  let best = arr[0];
  for (const s of arr) {
    if (s.hour <= hour) best = s;
    else break;
  }
  return best;
}

export let lastHandle: RunHandle | null = null;
export function setLastHandle(h: RunHandle | null) {
  lastHandle = h;
}

export { STORAGE_KEYS };
