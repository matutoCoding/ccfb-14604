/**
 * WebGPU 仿真引擎:驱动 gate/edge/cell/harvest 四个 compute pass,
 * 双缓冲 Jacobi 推进,季末读回计数器核对盐账。无 WebGPU 时由 runner 的 CPU 路径接管。
 */
import { FieldLayout, SimState } from './field';
import { SeasonData, HOURS } from './weather';
import { SimConfig, SimResult, HarvestEvent, Ledger, DailyCellRecord, makeCountersView, CellCountersView } from './gpuTypes';
import { edgeShader, cellShader, gateShader, harvestShader, WORKGROUP } from './shaders';
import { concToBe, SALT_BULK_DENSITY } from './units';

export interface GpuParams {
  nCells: number;
  nEdges: number;
  hour: number;
  maxHours: number;
  tide: number;
  temp: number;
  rh: number;
  wind: number;
  rad: number;
  rain: number;
  rainAhead: number;
  intakeLevel: number;
  seaNode: number;
  sumpNode: number;
  autoHarvest: number;
  harvestSaltMm: number;
  dailyCapacity: number;
  rain24: number;
  pad1: number;
  pad2: number;
}
const PARAM_FLOATS = 20;
const PARAM_BYTES = PARAM_FLOATS * 4;

export interface GpuSnapshot {
  hour: number;
  depth: Float32Array;
  dsalt: Float32Array;
  ssalt: Float32Array;
  flags: Uint32Array;
}

export class GpuEngine {
  device: GPUDevice;
  layout: FieldLayout;
  buffers: Record<string, GPUBuffer> = {};
  pipelines: Record<string, GPUComputePipeline> = {};
  bindGroup!: GPUBindGroup;
  bindGroupLayout!: GPUBindGroupLayout;
  uniform!: GPUBuffer;
  private edgeCount: number;
  private initialTotal: number;
  private initialWater: number;
  private counterLayout!: { N: number; harvestWords: number; reduceWords: number };

  private constructor(device: GPUDevice, layout: FieldLayout) {
    this.device = device;
    this.layout = layout;
    this.edgeCount = layout.edges.length;
    this.initialTotal = 0;
    this.initialWater = 0;
  }

  static async create(layout: FieldLayout, init: SimState): Promise<GpuEngine> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('无可用 WebGPU 适配器');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => {
      console.error('[WebGPU uncaptured]', (e as GPUUncapturedErrorEvent).error);
    });
    const eng = new GpuEngine(device, layout);
    eng.initialTotal = sum(init.dsalt) + sum(init.ssalt);
    eng.initialWater = sum(init.depth.map((d, i) => d * layout.cells[i].area));
    eng.allocate(init);
    eng.buildPipelines();
    return eng;
  }

  private makeBuffer(label: string, bytes: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView) {
    const b = this.device.createBuffer({ label, size: bytes, usage });
    if (data) this.device.queue.writeBuffer(b, 0, data as BufferSource);
    this.buffers[label] = b;
    return b;
  }

  private allocate(init: SimState) {
    const N = this.layout.cellCount;
    const E = this.edgeCount;
    const R = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const make = (label: string, arr: Float32Array | Uint32Array) =>
      this.makeBuffer(label, arr.byteLength, R, arr);

    this.uniform = this.makeBuffer('params', PARAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    // dynBuf: 6 区块 × N: 0 depth,1 dsalt,2 ssalt,3 dWater,4 dSalt,5 brineAge
    const dyn = new Float32Array(6 * N);
    dyn.set(init.depth, 0 * N);
    dyn.set(init.dsalt, 1 * N);
    dyn.set(init.ssalt, 2 * N);
    make('dynBuf', dyn);

    // prevBuf: 2 区块 × N: 0 prevDepth,1 prevDsalt
    const prev = new Float32Array(2 * N);
    prev.set(init.depth, 0 * N);
    prev.set(init.dsalt, 1 * N);
    make('prevBuf', prev);

    // staticBuf: 6 区块 × N(4 个 f32 属性 + cellType + outDegree,后两者按 u32 位写入)
    const stat = new Float32Array(6 * N);
    const statU32 = new Uint32Array(stat.buffer);
    const outDeg = new Uint32Array(N);
    for (const c of this.layout.cells) {
      stat[0 * N + c.id] = c.bottom;
      stat[1 * N + c.id] = c.ridge;
      stat[2 * N + c.id] = c.area;
      stat[3 * N + c.id] = c.windFetch;
      statU32[4 * N + c.id] = c.type;
    }
    for (const e of this.layout.edges) if (e.from < N) outDeg[e.from]++;
    statU32.set(outDeg, 5 * N);
    make('staticBuf', stat);

    // edgeBuf: 8 区块 × E: from,to,width,invert,isGate,gateOpen,fluxQ,fluxQSalt
    const edge = new Float32Array(8 * E);
    const edgeU32 = new Uint32Array(edge.buffer);
    for (const e of this.layout.edges) {
      edgeU32[0 * E + e.id] = e.from;
      edgeU32[1 * E + e.id] = e.to;
      edge[2 * E + e.id] = e.width;
      edge[3 * E + e.id] = e.invert;
      edgeU32[4 * E + e.id] = e.isGate ? 1 : 0;
      edgeU32[5 * E + e.id] = init.gateOpen[e.id];
    }
    make('edgeBuf', edge);

    // linkBuf: inCount(N)+outCount(N)+inEdges(N*16)+outEdges(N*16),按 u32 位存
    const LK = 16;
    const link = new Float32Array(2 * N + 2 * N * LK);
    const linkU32 = new Uint32Array(link.buffer);
    const inFill = new Uint32Array(N);
    const outFill = new Uint32Array(N);
    for (const e of this.layout.edges) {
      if (e.to < N) {
        const k = inFill[e.to]++;
        linkU32[2 * N + e.to * LK + k] = e.id;
      }
      if (e.from < N) {
        const k = outFill[e.from]++;
        linkU32[2 * N + N * LK + e.from * LK + k] = e.id;
      }
    }
    for (let i = 0; i < N; i++) {
      linkU32[i] = inFill[i];
      linkU32[N + i] = outFill[i];
    }
    make('linkBuf', link);

    // counterBuf: 9N 计数器 + N flags + (1+3072) harvest + reduce
    const harvestWords = 1 + 1024 * 3;
    const reduceWords = Math.max(1, Math.ceil(N / WORKGROUP));
    this.counterLayout = { N, harvestWords, reduceWords };
    const total = 9 * N + N + harvestWords + reduceWords;
    const counter = new Float32Array(total);
    make('counterBuf', counter);
  }

  private buildPipelines() {
    const device = this.device;
    const b = this.buffers;
    // 单 bind group:1 uniform + 4 storage(共 4 个 storage,低于设备上限 10)
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    const mk = (name: string, code: string) => {
      const module = device.createShaderModule({ code });
      this.pipelines[name] = device.createComputePipeline({ label: name, layout: pipelineLayout, compute: { module, entryPoint: 'main' } });
    };
    mk('gate', gateShader());
    mk('edge', edgeShader());
    mk('cell', cellShader());
    mk('harvest', harvestShader());

    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: b.dynBuf } },
        { binding: 2, resource: { buffer: b.prevBuf } },
        { binding: 3, resource: { buffer: b.staticBuf } },
        { binding: 4, resource: { buffer: b.edgeBuf } },
        { binding: 5, resource: { buffer: b.counterBuf } },
        { binding: 6, resource: { buffer: b.linkBuf } },
      ],
    });
  }

  private writeParams(hour: number, season: SeasonData, cfg: SimConfig) {
    const maxHours = Math.min(cfg.maxHours ?? HOURS, season.weather.length);
    const w = season.weather[hour];
    const rainAhead = hour + 6 < maxHours ? season.weather.slice(hour + 1, hour + 7).reduce((s, x) => s + x.rain, 0) : 0;
    const rain24 = hour + 24 <= maxHours ? season.weather.slice(hour, hour + 24).reduce((s, x) => s + x.rain, 0) : 0;
    const p: GpuParams = {
      nCells: this.layout.cellCount,
      nEdges: this.edgeCount,
      hour,
      maxHours,
      tide: season.tides[hour],
      temp: w.t,
      rh: w.rh,
      wind: w.wind,
      rad: w.rad,
      rain: w.rain,
      rainAhead,
      intakeLevel: season.intakeLevel,
      seaNode: this.layout.seaNode,
      sumpNode: this.layout.sumpNode,
      autoHarvest: cfg.autoHarvest ? 1 : 0,
      harvestSaltMm: cfg.harvestSaltMm,
      dailyCapacity: cfg.dailyCapacity,
      rain24,
      pad1: 0,
      pad2: 0,
    };
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array(Object.values(p) as number[]));
  }

  async runSeason(
    season: SeasonData,
    cfg: SimConfig,
    tracked: number[],
    onHour?: (snap: GpuSnapshot) => void,
  ): Promise<SimResult> {
    const N = this.layout.cellCount;
    const maxHours = Math.min(cfg.maxHours ?? HOURS, season.weather.length);
    const cellGroups = Math.ceil(N / WORKGROUP);
    const edgeGroups = Math.ceil(this.edgeCount / WORKGROUP);
    const history = new Map<number, DailyCellRecord[]>(tracked.map((id) => [id, []]));

    const dyn = this.buffers.dynBuf;
    const prev = this.buffers.prevBuf;
    for (let hour = 0; hour < maxHours; hour++) {
      this.writeParams(hour, season, cfg);
      const encoder = this.device.createCommandEncoder();
      // 通量由 edge pass 每步覆写本边独占槽位,cell pass 局部归约,无需清零 dWater/dSalt

      const pass = encoder.beginComputePass();
      pass.setBindGroup(0, this.bindGroup);
      pass.setPipeline(this.pipelines.gate);
      pass.dispatchWorkgroups(edgeGroups);
      pass.setPipeline(this.pipelines.edge);
      pass.dispatchWorkgroups(edgeGroups);
      pass.setPipeline(this.pipelines.cell);
      pass.dispatchWorkgroups(cellGroups);
      pass.setPipeline(this.pipelines.harvest);
      pass.dispatchWorkgroups(1);
      pass.end();

      // 双缓冲:current depth/dsalt(dyn 区块0/1)拷到 prevBuf,下轮 edge 读 prev
      encoder.copyBufferToBuffer(dyn, 0 * N * 4, prev, 0 * N * 4, N * 4);
      encoder.copyBufferToBuffer(dyn, 1 * N * 4, prev, 1 * N * 4, N * 4);
      this.device.queue.submit([encoder.finish()]);

      // 每日 23 点:一次全量读回,同时产出历史曲线与时间轴快照,避免重复回读
      if (hour % 24 === 23) {
        const snap = await this.readSnapshot(hour);
        for (const id of tracked) {
          const c = this.layout.cells[id];
          const vol = snap.depth[id] * c.area;
          const be = vol > 1e-9 ? concToBe(snap.dsalt[id] / vol) : 0;
          const saltMm = (snap.ssalt[id] / SALT_BULK_DENSITY / c.area) * 1000;
          history.get(id)!.push({
            day: (hour - 23) / 24,
            depth: +snap.depth[id].toFixed(4),
            be: +be.toFixed(3),
            ssalt: +snap.ssalt[id].toFixed(1),
            saltMm: +saltMm.toFixed(2),
          });
        }
        onHour?.(snap);
      } else if (onHour && hour === maxHours - 1) {
        onHour(await this.readSnapshot(hour));
      }
    }
    await this.device.queue.onSubmittedWorkDone();
    return this.collectResult(tracked, history, maxHours);
  }

  private async readSnapshot(hour: number): Promise<GpuSnapshot> {
    const N = this.layout.cellCount;
    const dyn = await this.readF32(this.buffers.dynBuf, 6 * N);
    const counter = await this.readF32(this.buffers.counterBuf, 10 * N + this.counterLayout.harvestWords + this.counterLayout.reduceWords);
    const depth = Float32Array.from(dyn.slice(0 * N, 1 * N));
    const dsalt = Float32Array.from(dyn.slice(1 * N, 2 * N));
    const ssalt = Float32Array.from(dyn.slice(2 * N, 3 * N));
    const flags = f32ToU32(counter, 9 * N, N);
    return { hour, depth, dsalt, ssalt, flags };
  }

  private readF32(src: GPUBuffer, n: number): Promise<Float32Array> {
    return this.readBack(src, n).then((ab) => new Float32Array(ab));
  }
  private readBack(src: GPUBuffer, n: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, staging, 0, n * 4);
    this.device.queue.submit([encoder.finish()]);
    return staging.mapAsync(GPUMapMode.READ).then(() => {
      const ab = staging.getMappedRange().slice(0);
      staging.unmap();
      staging.destroy();
      return ab;
    });
  }

  private async collectResult(tracked: number[], history: Map<number, DailyCellRecord[]>, maxHours: number): Promise<SimResult> {
    const N = this.layout.cellCount;
    const E = this.edgeCount;
    const dyn = await this.readF32(this.buffers.dynBuf, 6 * N);
    const edge = await this.readF32(this.buffers.edgeBuf, 8 * E);
    const counterTotal = 10 * N + this.counterLayout.harvestWords + this.counterLayout.reduceWords;
    const counter = await this.readF32(this.buffers.counterBuf, counterTotal);

    const depth = Float32Array.from(dyn.slice(0 * N, 1 * N));
    const dsalt = Float32Array.from(dyn.slice(1 * N, 2 * N));
    const ssalt = Float32Array.from(dyn.slice(2 * N, 3 * N));
    const gateOpenU32 = f32ToU32(edge, 5 * E, E);
    const gateOpen = Uint8Array.from(gateOpenU32);

    const counters = makeCountersView(N);
    const names = ['inSalt', 'outDrainSalt', 'spillSalt', 'rainWater', 'evapWater', 'inWater', 'outDrainWater', 'spillWater', 'harvestedSalt'] as const;
    for (let k = 0; k < names.length; k++) {
      counters[names[k]].set(Float32Array.from(counter.slice(k * N, (k + 1) * N)));
    }
    const flagsU32 = f32ToU32(counter, 9 * N, N);
    counters.bitternFlag = Uint8Array.from(flagsU32.map((f) => (f & 2 ? 1 : 0)));
    counters.overtopFlag = Uint8Array.from(flagsU32.map((f) => (f & 1 ? 1 : 0)));
    counters.harvestedFlag = Uint8Array.from(flagsU32.map((f) => (f & 4 ? 1 : 0)));

    const hbU32 = f32ToU32(counter, 10 * N, this.counterLayout.harvestWords);
    const hCount = Math.min(hbU32[0], 1024);
    const harvests: HarvestEvent[] = [];
    for (let k = 0; k < hCount; k++) {
      const cellId = hbU32[1 + k * 3];
      const hour = hbU32[2 + k * 3];
      const saltKg = new Float32Array(new Uint32Array([hbU32[3 + k * 3]]).buffer)[0];
      harvests.push({ hour, cellId, saltKg, auto: false, emergency: true });
    }

    const ledger = this.buildLedger(dsalt, ssalt, counters);
    return {
      state: {
        depth: Float64Array.from(depth),
        dsalt: Float64Array.from(dsalt),
        ssalt: Float64Array.from(ssalt),
        gateOpen,
      },
      counters,
      harvests,
      history,
      trackedCells: tracked,
      hours: maxHours,
      ledger,
      gpu: true,
    };
  }

  private buildLedger(dsalt: Float32Array, ssalt: Float32Array, c: CellCountersView): Ledger {
    const sum32 = (a: Float32Array) => a.reduce((s, x) => s + x, 0);
    const intakeSalt = sum32(c.inSalt);
    const drainSalt = sum32(c.outDrainSalt);
    const spillSalt = sum32(c.spillSalt);
    const harvestSalt = sum32(c.harvestedSalt);
    const finalDissolved = sum32(dsalt);
    const finalSolid = sum32(ssalt);
    const lhsSalt = this.initialTotal + intakeSalt;
    const rhsSalt = finalDissolved + finalSolid + drainSalt + spillSalt + harvestSalt;
    const absErr = Math.abs(lhsSalt - rhsSalt);

    const intakeWater = sum32(c.inWater);
    const drainWater = sum32(c.outDrainWater);
    const spillWater = sum32(c.spillWater);
    const rainWater = sum32(c.rainWater);
    const evapWater = sum32(c.evapWater);
    let finalWater = 0;
    for (let i = 0; i < this.layout.cellCount; i++) finalWater += 0; // 由 depth 读回在 runner 补
    return {
      initialTotal: this.initialTotal,
      intakeSalt,
      drainSalt,
      spillSalt,
      harvestSalt,
      finalDissolved,
      finalSolid,
      absErr,
      relErr: absErr / Math.max(1, lhsSalt),
      waterAbsErr: 0,
      waterRelErr: 0,
      intakeWater,
      drainWater,
      spillWater,
      rainWater,
      evapWater,
    };
  }

  destroy() {
    for (const b of Object.values(this.buffers)) b.destroy();
    this.uniform.destroy();
  }
}

function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** 把 Float32 缓冲中按位存放的整数安全转回 Uint32Array */
function f32ToU32(src: Float32Array, offset: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  const scratch = new ArrayBuffer(4);
  const fv = new Float32Array(scratch);
  const uv = new Uint32Array(scratch);
  for (let i = 0; i < count; i++) {
    fv[0] = src[offset + i];
    out[i] = uv[0];
  }
  return out;
}

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}
