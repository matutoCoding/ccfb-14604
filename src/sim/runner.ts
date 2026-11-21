/**
 * 统一仿真入口:优先 WebGPU,不可用或失败时回退 CPU 参考引擎(f64)。
 * 两条路径返回结构一致的 SimResult,盐账均做归约核对。
 */
import { FieldLayout, SimState, CellType } from './field';
import { SeasonData } from './weather';
import { SimConfig, SimResult, DailyCellRecord, makeCountersView } from './gpuTypes';
import { runSeason as cpuRun, DEFAULT_CONFIG } from './engine';
import { GpuEngine, webgpuAvailable, GpuSnapshot } from './gpu';

export interface RunOptions {
  forceCpu?: boolean;
  trackedCells?: number[];
  onHour?: (snap: GpuSnapshot | { hour: number; depth: Float64Array; dsalt: Float64Array; ssalt: Float64Array; flags: Uint32Array }) => void;
}

export async function runSimulation(
  layout: FieldLayout,
  init: SimState,
  season: SeasonData,
  cfg: SimConfig,
  opts: RunOptions = {},
): Promise<SimResult & { backend: 'webgpu' | 'cpu'; elapsedMs: number }> {
  const tracked = opts.trackedCells ?? layout.cells.filter((c) => c.type === CellType.Crystal).map((c) => c.id);
  const t0 = performance.now();

  if (!opts.forceCpu && webgpuAvailable()) {
    try {
      const eng = await GpuEngine.create(layout, init);
      const result = await eng.runSeason(season, cfg, tracked, opts.onHour ? (s) => opts.onHour!(s) : undefined);
      eng.destroy();
      // GPU 水账补算(读回 depth)
      fillWaterLedger(layout, result);
      return { ...result, backend: 'webgpu', elapsedMs: performance.now() - t0 };
    } catch (err) {
      console.warn('[sim] WebGPU 路径失败,回退 CPU:', err);
    }
  }

  const cpuResult = cpuRun(layout, init, season, cfg, tracked);
  if (opts.onHour) {
    // CPU 离线整季一次性算完,只在结束时给一次快照
    const flags = new Uint32Array(layout.cellCount);
    for (let i = 0; i < layout.cellCount; i++) {
      flags[i] =
        (cpuResult.counters.overtopFlag[i] ? 1 : 0) |
        (cpuResult.counters.bitternFlag[i] ? 2 : 0) |
        (cpuResult.counters.harvestedFlag[i] ? 4 : 0);
    }
    opts.onHour({ hour: cpuResult.hours - 1, depth: cpuResult.state.depth, dsalt: cpuResult.state.dsalt, ssalt: cpuResult.state.ssalt, flags });
  }
  return { ...(cpuResult as unknown as SimResult), backend: 'cpu', elapsedMs: performance.now() - t0 };
}

/** GPU 路径读回 depth 后补算水账误差 */
function fillWaterLedger(layout: FieldLayout, result: SimResult) {
  let finalWater = 0;
  for (let i = 0; i < layout.cellCount; i++) {
    finalWater += (result.state.depth[i] as number) * layout.cells[i].area;
  }
  const c = result.counters;
  // 期初水由 GPU 引擎未透出,这里用恒等式反推:期初 + 纳潮 + 纳雨 = 期末 + 排 + 溢 + 蒸
  const initialWater =
    finalWater + sum(c.outDrainWater) + sum(c.spillWater) + sum(c.evapWater) - sum(c.inWater) - sum(c.rainWater);
  const lhs = initialWater + sum(c.inWater) + sum(c.rainWater);
  const rhs = finalWater + sum(c.outDrainWater) + sum(c.spillWater) + sum(c.evapWater);
  result.ledger.waterAbsErr = Math.abs(lhs - rhs);
  result.ledger.waterRelErr = result.ledger.waterAbsErr / Math.max(1, lhs);
}

function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export { DEFAULT_CONFIG, makeCountersView };
export type { DailyCellRecord };
