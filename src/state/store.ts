/**
 * 全局应用状态(轻量发布订阅单例):布局、季节、最新仿真结果、闸门手动覆盖、当前时刻。
 */
import { buildLayout, FieldLayout, initialState, SimState, CellType, STAGES } from '../sim/field';
import { generateSeason, SeasonData, generateLastSeason } from '../sim/weather';
import { SimResult } from '../sim/gpuTypes';
import { idb, STORAGE_KEYS } from '../db/idb';

export interface LiveSnapshot {
  hour: number;
  depth: Float32Array | Float64Array;
  dsalt: Float32Array | Float64Array;
  ssalt: Float32Array | Float64Array;
  flags: Uint32Array;
}

type Listener = () => void;

class AppStore {
  layout: FieldLayout = buildLayout();
  init: SimState = initialState(this.layout);
  season: SeasonData = generateSeason();
  lastSeason: SeasonData = generateLastSeason();
  result: (SimResult & { backend?: string; elapsedMs?: number }) | null = null;
  live: LiveSnapshot | null = null;
  gateOverride = new Map<number, boolean>();
  harvestPlan = new Map<number, number[]>();
  settings = { autoHarvest: true, harvestSaltMm: 60, dailyCapacity: 3, forceCpu: false };
  currentHour = 0;
  selectedCell = -1;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn();
  }

  resetField() {
    this.layout = buildLayout();
    this.init = initialState(this.layout);
    this.gateOverride.clear();
    this.result = null;
    this.live = null;
    this.currentHour = 0;
    this.emit();
  }

  setGate(edgeId: number, open: boolean) {
    this.gateOverride.set(edgeId, open);
    this.emit();
  }
  clearGateOverrides() {
    this.gateOverride.clear();
    this.emit();
  }

  async persist() {
    await idb.put('settings', STORAGE_KEYS.settings, this.settings);
    await idb.put('plans', STORAGE_KEYS.plan, {
      gates: Array.from(this.gateOverride.entries()),
      harvest: Array.from(this.harvestPlan.entries()),
    });
  }

  async restore() {
    const s = await idb.get<typeof this.settings>('settings', STORAGE_KEYS.settings);
    if (s) this.settings = { ...this.settings, ...s };
    const p = await idb.get<{ gates: [number, boolean][]; harvest: [number, number[]][] }>('plans', STORAGE_KEYS.plan);
    if (p) {
      this.gateOverride = new Map(p.gates);
      this.harvestPlan = new Map(p.harvest.map(([h, ids]) => [Number(h), ids]));
    }
    this.emit();
  }

  get crystalCells() {
    return this.layout.cells.filter((c) => c.type === CellType.Crystal);
  }
  get stageNames() {
    return STAGES.map((s) => s.name);
  }
}

export const store = new AppStore();
