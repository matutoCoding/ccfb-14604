/**
 * CPU 参考仿真引擎(f64)。盐账守恒的基准实现,WGSL 着色器逐式对照本文件。
 *
 * 每小时:
 *   1) 边(闸/渠)汇流:Jacobi 读取上一步状态,堰流公式,海/苦卤井为边界节点
 *   2) 格子更新:纳雨→蒸发→漫顶→析盐/化盐→收盐事件
 * 盐账:每格累计边界通量,季末全局归约,相对误差要求 ≤ 1e-3。
 */
import {
  SEA_CONC,
  SAT_CONC,
  SAT_BE,
  BITTERN_BE,
  PRECIP_KEEP,
  SALT_BULK_DENSITY,
  WEIR_COEF,
  SECONDS_PER_HOUR,
  evapMmH,
  beToConc,
  concToBe,
} from './units';import {
  FieldLayout,
  SimState,
  CellType,
} from './field';
import { SeasonData, HOURS, STORM_END, STORM_START } from './weather';

export interface CellCounters {
  inSalt: Float64Array; // 纳潮/上游来水溶盐累计 kg
  outDrainSalt: Float64Array; // 排淡+苦卤带走溶盐 kg
  spillSalt: Float64Array; // 漫顶损失(溶盐+固态盐)kg
  rainWater: Float64Array; // 纳雨 m³
  evapWater: Float64Array; // 蒸发 m³
  inWater: Float64Array; // 进水体积 m³(纳潮+上游)
  outDrainWater: Float64Array; // 排走水 m³
  spillWater: Float64Array; // 漫顶水 m³
  harvestedSalt: Float64Array; // 收盐累计 kg
  bitternFlag: Uint8Array; // 苦卤标记
  overtopFlag: Uint8Array; // 漫顶标记(当步)
  harvestedFlag: Uint8Array; // 本季已收过
}

export interface HarvestEvent {
  hour: number;
  cellId: number;
  saltKg: number;
  auto: boolean;
  emergency: boolean; // 暴雨预警抢收
}

export interface DailyCellRecord {
  day: number;
  depth: number;
  be: number;
  ssalt: number; // kg
  saltMm: number; // 盐层厚度 mm
}

export interface SimConfig {
  autoHarvest: boolean;
  harvestSaltMm: number; // 触发收盐的盐层厚度 mm
  dailyCapacity: number; // 每天可收池数
  maxHours?: number; // 仿真截止小时(默认整季)
  /** 闸门手动覆盖:edgeId → open;未给则用状态里的 gateOpen */
  gateOverride?: Map<number, boolean>;
  /** 手动收盐计划:hour → cellId[] */
  harvestPlan?: Map<number, number[]>;
  /** 每日历史采样回调(可选,降内存用) */
  onDay?: (day: number) => void;
  /** 每 6 小时快照回调(时间轴回放用) */
  onHour?: (hour: number, depth: Float64Array, dsalt: Float64Array, ssalt: Float64Array, flags: Uint32Array) => void;
  snapshotEvery?: number;
}

export interface SimResult {
  state: SimState;
  counters: CellCounters;
  harvests: HarvestEvent[];
  /** 每格每日记录(按需格采样,默认结晶池) */
  history: Map<number, DailyCellRecord[]>;
  trackedCells: number[];
  hours: number;
  ledger: Ledger;
}

export interface Ledger {
  initialTotal: number;
  intakeSalt: number;
  drainSalt: number;
  spillSalt: number;
  harvestSalt: number;
  finalDissolved: number;
  finalSolid: number;
  absErr: number;
  relErr: number;
  waterAbsErr: number;
  waterRelErr: number;
  intakeWater: number;
  drainWater: number;
  spillWater: number;
  rainWater: number;
  evapWater: number;
}

function makeCounters(n: number): CellCounters {
  return {
    inSalt: new Float64Array(n),
    outDrainSalt: new Float64Array(n),
    spillSalt: new Float64Array(n),
    rainWater: new Float64Array(n),
    evapWater: new Float64Array(n),
    inWater: new Float64Array(n),
    outDrainWater: new Float64Array(n),
    spillWater: new Float64Array(n),
    harvestedSalt: new Float64Array(n),
    bitternFlag: new Uint8Array(n),
    overtopFlag: new Uint8Array(n),
    harvestedFlag: new Uint8Array(n),
  };
}

export function saltLayerMm(ssaltKg: number, areaM2: number): number {
  return (ssaltKg / SALT_BULK_DENSITY / areaM2) * 1000;
}

export function waterLevel(layout: FieldLayout, depth: Float64Array, i: number): number {
  return layout.cells[i].bottom + depth[i];
}

/**
 * 主推进。state 会被原地更新(双缓冲在内部处理)。
 */
export function runSeason(
  layout: FieldLayout,
  initial: SimState,
  season: SeasonData,
  cfg: SimConfig,
  trackedCells?: number[],
): SimResult {
  const N = layout.cellCount;
  const SEA = layout.seaNode;
  const SUMP = layout.sumpNode;
  const state: SimState = {
    depth: initial.depth.slice(),
    dsalt: initial.dsalt.slice(),
    ssalt: initial.ssalt.slice(),
    gateOpen: initial.gateOpen.slice(),
  };
  const prevDepth = new Float64Array(N);
  const prevDsalt = new Float64Array(N);
  const counters = makeCounters(N);
  const harvests: HarvestEvent[] = [];
  const track = trackedCells ?? layout.cells.filter((c) => c.type === CellType.Crystal).map((c) => c.id);
  const history = new Map<number, DailyCellRecord[]>(track.map((id) => [id, []]));

  // 边通量暂存
  const eq = new Float64Array(layout.edges.length);
  const esalt = new Float64Array(layout.edges.length);
  // 格子净累积
  const dWater = new Float64Array(N);
  const dSalt = new Float64Array(N);
  // 卤水龄期(小时):有新水进来则清零,持续蒸发则累积;用于苦卤(老卤)判定
  const brineAge = new Float64Array(N);

  const initialTotal = sum(state.dsalt) + sum(state.ssalt);
  const initialWater = sum(state.depth.map((d, i) => d * layout.cells[i].area));

  const scheduledToday = new Set<number>();
  const maxHours = Math.min(cfg.maxHours ?? HOURS, season.weather.length);

  for (let hour = 0; hour < maxHours; hour++) {
    const w = season.weather[hour];
    const tide = season.tides[hour];
    // 漫顶标记锁存:一旦漫顶本季保持,便于时间轴回放观察

    // 闸门自动调度:纳潮/排淡/节制/埝闸统一水位联动
    const rainNow = w.rain;
    const rainAhead = hour + 6 < maxHours ? season.weather.slice(hour + 1, hour + 7).reduce((s, x) => s + x.rain, 0) : 0;
    const stormMode = rainNow > 3 || rainAhead > 30;
    for (const e of layout.edges) {
      if (e.from === SEA) {
        // 纳潮主闸:潮位够高、纳潮库有余量、非暴雨时纳潮
        state.gateOpen[e.id] = !stormMode && tide >= season.intakeLevel && depthBelowRidge(layout, state.depth, e.to) ? 1 : 0;
      } else if (e.to === SEA) {
        // 排淡闸:常开排涝
        state.gateOpen[e.id] = 1;
      } else if (e.isGate && e.to < N) {
        // 批式轮转:下游蒸到低水位才开闸补卤,到高水位关闸;暴雨前关闸滞洪,
        // 让每格卤水有足够停留时间逐级浓缩(老滩长"看卤调闸"的自动化)
        const cell = layout.cells[e.to];
        const low = cell.ridge * (stormMode ? 0.15 : 0.28);
        const high = cell.ridge * (stormMode ? 0.4 : 0.52);
        if (state.depth[e.to] < low) state.gateOpen[e.id] = 1;
        else if (state.depth[e.to] > high) state.gateOpen[e.id] = 0;
      }
    }
    if (cfg.gateOverride) {
      for (const [eid, open] of cfg.gateOverride) state.gateOpen[eid] = open ? 1 : 0;
    }

    prevDepth.set(state.depth);
    prevDsalt.set(state.dsalt);
    dWater.fill(0);
    dSalt.fill(0);

    // ---- pass 1: 边汇流(读 prev,写暂存与净累积) ----
    for (let ei = 0; ei < layout.edges.length; ei++) {
      const e = layout.edges[ei];
      if (!state.gateOpen[ei]) {
        eq[ei] = 0;
        esalt[ei] = 0;
        continue;
      }
      const hFrom = e.from >= N ? boundaryHead(e.from, tide, e, SEA) : waterLevel(layout, prevDepth, e.from);
      const hTo = e.to >= N ? boundaryHead(e.to, tide, e, SEA) : waterLevel(layout, prevDepth, e.to);
      const dh = hFrom - hTo;
      if (dh <= 0.005) {
        eq[ei] = 0;
        esalt[ei] = 0;
        continue;
      }
      // 堰流 Q = Cw·w·dh^1.5 (m³/s),乘 3600 得小时体积
      let q = WEIR_COEF * e.width * Math.pow(dh, 1.5) * SECONDS_PER_HOUR;
      if (e.from < N) {
        const avail = prevDepth[e.from] * layout.cells[e.from].area;
        // 单条边每步最多引走上一格存量的 1/4,避免大池→小格瞬时击穿
        const share = Math.max(1, layout.outgoing[e.from].length);
        const limit = (avail * 0.5) / share;
        if (q > limit) q = limit;
      }
      const concFrom = e.from >= N ? (e.from === SEA ? SEA_CONC : 0) : prevDsalt[e.from] / Math.max(1e-9, prevDepth[e.from] * layout.cells[e.from].area);
      eq[ei] = q;
      esalt[ei] = q * concFrom;

      if (e.from < N) {
        dWater[e.from] -= q;
        dSalt[e.from] -= q * concFrom;
      }
      if (e.to < N) {
        dWater[e.to] += q;
        dSalt[e.to] += q * concFrom;
      }
      // 边界记账(记在相邻真实格子上)
      if (e.from === SEA && e.to < N) {
        counters.inWater[e.to] += q;
        counters.inSalt[e.to] += q * SEA_CONC;
      }
      if (e.to === SEA && e.from < N) {
        counters.outDrainWater[e.from] += q;
        counters.outDrainSalt[e.from] += q * concFrom;
      }
      if (e.to === SUMP && e.from < N) {
        counters.outDrainWater[e.from] += q;
        counters.outDrainSalt[e.from] += q * concFrom;
      }
    }

    // ---- pass 2: 格子物理更新 ----
    for (let i = 0; i < N; i++) {
      const cell = layout.cells[i];
      let vol = prevDepth[i] * cell.area + dWater[i];
      let salt = prevDsalt[i] + dSalt[i];
      if (vol < 0) {
        vol = 0;
        salt = Math.max(0, salt);
      }

      // 纳雨(雨水零盐)
      const rainVol = (w.rain / 1000) * cell.area;
      if (rainVol > 0) {
        vol += rainVol;
        counters.rainWater[i] += rainVol;
      }

      // 蒸发(风吹程修正,蒸发只走水不走盐)
      const eMm = evapMmH(w.t, w.rh, w.wind, w.rad) * cell.windFetch;
      let evapVol = (Math.min(eMm, 1.4) / 1000) * cell.area;
      evapVol = Math.min(evapVol, vol);
      vol -= evapVol;
      counters.evapWater[i] += evapVol;

      // 漫顶:水面超过埝埂顶即溢出(带同浓度卤水;固态盐只在极端漫顶时按比例损失)
      const ridgeTop = cell.bottom + cell.ridge;
      const depthNow = vol / cell.area;
      if (cell.bottom + depthNow > ridgeTop) {
        const spillV = (cell.bottom + depthNow - ridgeTop) * cell.area;
        const cNow = vol > 1e-9 ? salt / vol : 0;
        vol -= spillV;
        salt -= spillV * cNow;
        counters.spillWater[i] += spillV;
        counters.spillSalt[i] += spillV * cNow;
        counters.overtopFlag[i] = 1;
        // 漫顶水冲走表层 5% 固态盐
        const solidLoss = state.ssalt[i] * 0.05 * Math.min(1, spillV / Math.max(1, vol + spillV));
        state.ssalt[i] -= solidLoss;
        counters.spillSalt[i] += solidLoss;
      }

      // 析盐 / 化盐:仅结晶池析出固态盐;其它池即使过饱和也保持溶解态
      if (vol > 1e-9) {
        const conc = salt / vol;
        if (cell.type === CellType.Crystal && conc > SAT_CONC) {
          // 超过饱和:85% 析出,15% 留溶解态(苦卤镁盐)
          const excess = salt - SAT_CONC * vol;
          const precip = excess * (1 - PRECIP_KEEP);
          salt -= precip;
          state.ssalt[i] += precip;
        } else if (conc < SAT_CONC && state.ssalt[i] > 0) {
          // 雨水冲淡:盐板回溶,补到饱和或盐板耗尽
          const deficit = SAT_CONC * vol - salt;
          const dissolve = Math.min(deficit, state.ssalt[i]);
          salt += dissolve;
          state.ssalt[i] -= dissolve;
        }
        // 龄期:本步有明显上游来水则返新,否则老化
        if (dWater[i] > prevDepth[i] * cell.area * 0.05) brineAge[i] = 0;
        else brineAge[i] += 1;
        // 苦卤判定:溶解浓度反查 Bé>30,或结晶格长期(≥10 天)处于饱和蒸发、镁盐富集的老卤
        const beNow = concToBe(salt / vol);
        const agedBittern = cell.type === CellType.Crystal && beNow >= SAT_BE - 0.5 && brineAge[i] >= 240;
        if (beNow > BITTERN_BE || agedBittern) counters.bitternFlag[i] = 1;
      }

      state.depth[i] = Math.max(0, vol / cell.area);
      state.dsalt[i] = Math.max(0, salt);
    }

    // ---- 收盐:手动计划 + 自动调度 + 暴雨预警抢收 ----
    scheduledToday.clear();
    const manual = cfg.harvestPlan?.get(hour);
    if (manual) for (const id of manual) scheduledToday.add(id);
    if (cfg.autoHarvest && hour % 24 === 6) {
      const picked = scheduleHarvest(layout, state, cfg, counters);
      for (const id of picked) scheduledToday.add(id);
    }
    // 暴雨预警:未来 24h(含当前小时)累计雨 > 60mm 时,所有有盐板的结晶池紧急抢收
    const rain24 = hour + 24 <= maxHours ? season.weather.slice(hour, hour + 24).reduce((s, x) => s + x.rain, 0) : 0;
    const emergency = rain24 > 60;
    if (emergency) {
      for (const cell of layout.cells) {
        if (cell.type === CellType.Crystal && state.ssalt[cell.id] > 0) scheduledToday.add(cell.id);
      }
    }
    for (const id of scheduledToday) {
      const take = state.ssalt[id];
      if (take <= 0) continue;
      state.ssalt[id] = 0;
      counters.harvestedSalt[id] += take;
      counters.harvestedFlag[id] = 1;
      harvests.push({ hour, cellId: id, saltKg: take, auto: !manual?.includes(id) && !emergency, emergency });
    }

    // ---- 每日 23 点采样历史 ----
    if (hour % 24 === 23) {
      const day = (hour - 23) / 24;
      for (const id of track) {
        const c = layout.cells[id];
        const vol = state.depth[id] * c.area;
        const be = vol > 1e-9 ? concToBe(state.dsalt[id] / vol) : 0;
        history.get(id)!.push({
          day,
          depth: +state.depth[id].toFixed(4),
          be: +be.toFixed(3),
          ssalt: +state.ssalt[id].toFixed(1),
          saltMm: +saltLayerMm(state.ssalt[id], c.area).toFixed(2),
        });
      }
      cfg.onDay?.(day);
    }

    // ---- 定时快照(时间轴回放) ----
    const every = cfg.snapshotEvery ?? 6;
    if (cfg.onHour && (hour % every === 0 || hour === maxHours - 1)) {
      const flags = new Uint32Array(N);
      for (let i = 0; i < N; i++) {
        flags[i] =
          (counters.overtopFlag[i] ? 1 : 0) |
          (counters.bitternFlag[i] ? 2 : 0) |
          (counters.harvestedFlag[i] ? 4 : 0);
      }
      cfg.onHour(hour, state.depth, state.dsalt, state.ssalt, flags);
    }
  }

  const ledger = buildLedger(layout, state, counters, initialTotal, initialWater);
  return { state, counters, harvests, history, trackedCells: track, hours: maxHours, ledger };
}

function depthBelowRidge(layout: FieldLayout, depth: Float64Array, cellId: number): boolean {
  const c = layout.cells[cellId];
  return depth[cellId] < c.ridge * 0.85;
}

function boundaryHead(node: number, tide: number, e: { invert: number }, seaNode: number): number {
  if (node === seaNode) return tide;
  return e.invert - 0.5; // 苦卤井:低水位,开闸即排
}

function sum(a: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** 清晨排产:盐层达标的结晶池,按每天容量限制选池 */
export function scheduleHarvest(
  layout: FieldLayout,
  state: SimState,
  cfg: SimConfig,
  counters: CellCounters,
): number[] {
  const candidates = layout.cells
    .filter((c) => c.type === CellType.Crystal)
    .map((c) => ({ id: c.id, mm: saltLayerMm(state.ssalt[c.id], c.area) }))
    .filter((x) => x.mm >= cfg.harvestSaltMm)
    .sort((a, b) => b.mm - a.mm);
  return candidates.slice(0, cfg.dailyCapacity).map((x) => x.id);
}

export function buildLedger(
  layout: FieldLayout,
  state: SimState,
  c: CellCounters,
  initialTotal: number,
  initialWater: number,
): Ledger {
  const intakeSalt = sum(c.inSalt);
  const drainSalt = sum(c.outDrainSalt);
  const spillSalt = sum(c.spillSalt);
  const harvestSalt = sum(c.harvestedSalt);
  const finalDissolved = sum(state.dsalt);
  const finalSolid = sum(state.ssalt);

  // 盐账:期初 + 纳潮 = 期末(溶+固) + 排走 + 漫顶 + 收盐
  const lhsSalt = initialTotal + intakeSalt;
  const rhsSalt = finalDissolved + finalSolid + drainSalt + spillSalt + harvestSalt;
  const absErr = Math.abs(lhsSalt - rhsSalt);
  const relErr = absErr / Math.max(1, lhsSalt);

  const intakeWater = sum(c.inWater);
  const drainWater = sum(c.outDrainWater);
  const spillWater = sum(c.spillWater);
  const rainWater = sum(c.rainWater);
  const evapWater = sum(c.evapWater);
  let finalWater = 0;
  for (let i = 0; i < layout.cellCount; i++) finalWater += state.depth[i] * layout.cells[i].area;
  const lhsW = initialWater + intakeWater + rainWater;
  const rhsW = finalWater + drainWater + spillWater + evapWater;
  const waterAbsErr = Math.abs(lhsW - rhsW);
  const waterRelErr = waterAbsErr / Math.max(1, lhsW);

  return {
    initialTotal,
    intakeSalt,
    drainSalt,
    spillSalt,
    harvestSalt,
    finalDissolved,
    finalSolid,
    absErr,
    relErr,
    waterAbsErr,
    waterRelErr,
    intakeWater,
    drainWater,
    spillWater,
    rainWater,
    evapWater,
  };
}

export const DEFAULT_CONFIG: SimConfig = {
  autoHarvest: true,
  harvestSaltMm: 60,
  dailyCapacity: 3,
};

export { STORM_START, STORM_END };
