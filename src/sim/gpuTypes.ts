/**
 * GPU/CPU 共用的结果视图类型(f32 计数器,与 WebGPU 缓冲对应)。
 */
import { CellType } from './field';

export interface CellCountersView {
  inSalt: Float32Array;
  outDrainSalt: Float32Array;
  spillSalt: Float32Array;
  rainWater: Float32Array;
  evapWater: Float32Array;
  inWater: Float32Array;
  outDrainWater: Float32Array;
  spillWater: Float32Array;
  harvestedSalt: Float32Array;
  bitternFlag: Uint8Array;
  overtopFlag: Uint8Array;
  harvestedFlag: Uint8Array;
}

export interface HarvestEvent {
  hour: number;
  cellId: number;
  saltKg: number;
  auto: boolean;
  emergency: boolean;
}

export interface DailyCellRecord {
  day: number;
  depth: number;
  be: number;
  ssalt: number;
  saltMm: number;
}

export interface SimConfig {
  autoHarvest: boolean;
  harvestSaltMm: number;
  dailyCapacity: number;
  maxHours?: number;
  gateOverride?: Map<number, boolean>;
  harvestPlan?: Map<number, number[]>;
  onDay?: (day: number) => void;
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

export interface SimResult {
  state: {
    depth: ArrayLike<number>;
    dsalt: ArrayLike<number>;
    ssalt: ArrayLike<number>;
    gateOpen: ArrayLike<number>;
  };
  counters: CellCountersView | import('./engine').CellCounters;
  harvests: HarvestEvent[];
  history: Map<number, DailyCellRecord[]>;
  trackedCells: number[];
  hours: number;
  ledger: Ledger;
  gpu?: boolean;
}

export function makeCountersView(n: number): CellCountersView {
  return {
    inSalt: new Float32Array(n),
    outDrainSalt: new Float32Array(n),
    spillSalt: new Float32Array(n),
    rainWater: new Float32Array(n),
    evapWater: new Float32Array(n),
    inWater: new Float32Array(n),
    outDrainWater: new Float32Array(n),
    spillWater: new Float32Array(n),
    harvestedSalt: new Float32Array(n),
    bitternFlag: new Uint8Array(n),
    overtopFlag: new Uint8Array(n),
    harvestedFlag: new Uint8Array(n),
  };
}

export { CellType };
