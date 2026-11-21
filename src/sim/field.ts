/**
 * 测试滩田布局:230 格实测式网格 + 海/苦卤井两个边界节点。
 * 纳潮库→6 级蒸发池→调节池→结晶池,每级内蛇形流动,级间以闸门衔接。
 */
import { beToConc } from './units';

export enum CellType {
  Reservoir = 0,
  Evap = 1,
  Reg = 2,
  Crystal = 3,
}

export interface StageDef {
  name: string;
  type: CellType;
  rows: number;
  cols: number;
  area: number; // 单格面积 m²
  ridge: number; // 埝埂高(相对池底)m
  initDepth: number;
  initBe: number;
}

export const STAGES: StageDef[] = [
  { name: '纳潮库', type: CellType.Reservoir, rows: 1, cols: 6, area: 40000, ridge: 2.6, initDepth: 1.0, initBe: 3.2 },
  { name: '一级蒸发', type: CellType.Evap, rows: 2, cols: 16, area: 12000, ridge: 2.0, initDepth: 0.55, initBe: 4.5 },
  { name: '二级蒸发', type: CellType.Evap, rows: 2, cols: 16, area: 10000, ridge: 1.9, initDepth: 0.5, initBe: 7 },
  { name: '三级蒸发', type: CellType.Evap, rows: 2, cols: 16, area: 9000, ridge: 1.8, initDepth: 0.45, initBe: 10 },
  { name: '四级蒸发', type: CellType.Evap, rows: 2, cols: 16, area: 8000, ridge: 1.7, initDepth: 0.42, initBe: 14 },
  { name: '五级蒸发', type: CellType.Evap, rows: 1, cols: 16, area: 12000, ridge: 1.6, initDepth: 0.4, initBe: 18 },
  { name: '六级蒸发', type: CellType.Evap, rows: 1, cols: 16, area: 10000, ridge: 1.5, initDepth: 0.38, initBe: 21.5 },
  { name: '调节池', type: CellType.Reg, rows: 1, cols: 16, area: 9000, ridge: 1.4, initDepth: 0.35, initBe: 24 },
  { name: '结晶区', type: CellType.Crystal, rows: 3, cols: 16, area: 2400, ridge: 1.2, initDepth: 0.3, initBe: 25 },
];

export interface CellStatic {
  id: number;
  stage: number;
  type: CellType;
  row: number;
  col: number;
  x: number; // 中心坐标 m
  y: number;
  w: number; // 占地宽 m
  h: number;
  bottom: number; // 池底高程 m
  ridge: number; // 埝埂高(相对池底)
  area: number;
  windFetch: number; // 风吹程系数
}

export interface EdgeDef {
  id: number;
  from: number;
  to: number;
  width: number; // 闸/渠宽 m
  invert: number; // 堰顶高程 m
  isGate: boolean;
  name: string;
}

export interface FieldLayout {
  cells: CellStatic[];
  edges: EdgeDef[];
  cellCount: number;
  seaNode: number;
  sumpNode: number;
  nodeCount: number;
  /** 每格入边索引(Jacobi 汇流用) */
  incoming: number[][];
  /** 每格出边索引 */
  outgoing: number[][];
  stageRanges: { start: number; end: number; name: string }[];
}

/** 确定性线性同余随机数(造地形用) */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function buildLayout(): FieldLayout {
  const rnd = lcg(20250701);
  const cells: CellStatic[] = [];
  const stageRanges: { start: number; end: number; name: string }[] = [];
  const GAP = 6; // 埝埂+沟渠间距 m

  let bandStartRow = 0;
  const bandOfStage = STAGES.map((st) => {
    const r0 = bandStartRow;
    bandStartRow += st.rows;
    return r0;
  });

  for (let si = 0; si < STAGES.length; si++) {
    const st = STAGES[si];
    const start = cells.length;
    for (let r = 0; r < st.rows; r++) {
      for (let c = 0; c < st.cols; c++) {
        const id = cells.length;
        const globalRow = bandOfStage[si] + r;
        const side = Math.sqrt(st.area);
        const bottom =
          4.2 - si * 0.42 - (r / Math.max(1, st.rows)) * 0.06 + (rnd() - 0.5) * 0.08;
        cells.push({
          id,
          stage: si,
          type: st.type,
          row: globalRow,
          col: c,
          x: c * (side + GAP) + side / 2,
          y: globalRow * (side + GAP) + side / 2,
          w: side,
          h: side,
          bottom: +bottom.toFixed(3),
          ridge: st.ridge + (rnd() - 0.5) * 0.06,
          area: st.area,
          windFetch: 1,
        });
      }
    }
    stageRanges.push({ start, end: cells.length, name: st.name });
  }

  // 风吹程:同列连续池子越多,下风头(列号大)系数越高
  for (const cell of cells) {
    const band = STAGES[cell.stage];
    const pos = cell.col / Math.max(1, band.cols - 1);
    cell.windFetch = +(0.82 + 0.36 * pos).toFixed(3);
  }

  const cellCount = cells.length;
  const seaNode = cellCount;
  const sumpNode = cellCount + 1;
  const nodeCount = cellCount + 2;
  const edges: EdgeDef[] = [];
  const incoming: number[][] = Array.from({ length: nodeCount }, () => []);
  const outgoing: number[][] = Array.from({ length: nodeCount }, () => []);

  const addEdge = (from: number, to: number, isGate: boolean, name: string, width: number, invert: number) => {
    const id = edges.length;
    edges.push({ id, from, to, width, isGate, invert, name });
    outgoing[from].push(id);
    incoming[to].push(id);
  };

  const cellAt = (si: number, k: number) => stageRanges[si].start + k;

  // 级内连接:每行内沿列向单向流(埝口溢流堰);行末以汇流闸跳到下一行首格
  for (let si = 0; si < STAGES.length; si++) {
    const st = STAGES[si];
    for (let rr = 0; rr < st.rows; rr++) {
      const base = rr * st.cols;
      for (let c = 0; c < st.cols - 1; c++) {
        const a = cellAt(si, base + c);
        const b = cellAt(si, base + c + 1);
        const inv = Math.max(cells[a].bottom, cells[b].bottom) + 0.75;
        // 埝口设可启闭埝闸:平时按水位联动,保证逐级停留蒸发
        addEdge(a, b, true, `${st.name}埝闸`, 4, +inv.toFixed(3));
      }
      if (rr < st.rows - 1) {
        const a = cellAt(si, base + st.cols - 1);
        const b = cellAt(si, base + st.cols);
        const inv = Math.max(cells[a].bottom, cells[b].bottom) + 0.7;
        addEdge(a, b, true, `${st.name}行端汇流闸`, 5, +inv.toFixed(3));
      }    }
  }

  // 级间衔接闸:下一级多行时,分水到每一行首格(同生共死的一组闸)
  for (let si = 0; si < STAGES.length - 1; si++) {
    const a = cellAt(si, STAGES[si].rows * STAGES[si].cols - 1);
    const nextRows = STAGES[si + 1].rows;
    for (let rr = 0; rr < nextRows; rr++) {
      const b = cellAt(si + 1, rr * STAGES[si + 1].cols);
      const inv = Math.max(cells[a].bottom, cells[b].bottom) + 0.65;
      addEdge(a, b, true, `${STAGES[si].name}→${STAGES[si + 1].name}节制闸${rr + 1}`, 5, +inv.toFixed(3));
    }
  }


  // 纳潮闸:海 → 纳潮库首格
  const first = cellAt(0, 0);
  addEdge(seaNode, first, true, '纳潮主闸', 8, +(cells[first].bottom + 0.2).toFixed(3));

  // 结晶末端 → 海(排淡)与苦卤井:每行末端各设排淡闸,分片排涝
  const lastStage = STAGES.length - 1;
  const ls = STAGES[lastStage];
  for (let rr = 0; rr < ls.rows; rr++) {
    const end = cellAt(lastStage, rr * ls.cols + ls.cols - 1);
    addEdge(end, seaNode, true, `排淡闸${rr + 1}`, 6, +(cells[end].bottom + 0.3).toFixed(3));
    addEdge(end, sumpNode, true, `苦卤排放闸${rr + 1}`, 4, +(cells[end].bottom + 0.3).toFixed(3));
  }

  return { cells, edges, cellCount, seaNode, sumpNode, nodeCount, incoming, outgoing, stageRanges };
}

/** 初始状态(SoA) */
export interface SimState {
  depth: Float64Array; // 卤水深度 m
  dsalt: Float64Array; // 溶解盐 kg
  ssalt: Float64Array; // 固态盐(盐板)kg
  gateOpen: Uint8Array; // 闸门状态
}

export function initialState(layout: FieldLayout): SimState {
  const n = layout.cellCount;
  const depth = new Float64Array(n);
  const dsalt = new Float64Array(n);
  const ssalt = new Float64Array(n);
  for (const c of layout.cells) {
    const st = STAGES[c.stage];
    depth[c.id] = st.initDepth;
    dsalt[c.id] = st.initDepth * c.area * beToConc(st.initBe);
  }
  const gateOpen = new Uint8Array(layout.edges.length).fill(1);
  // 苦卤闸默认关闭;排淡闸默认开启(末端沟链需保持通畅)
  for (const e of layout.edges) {
    if (e.to === layout.sumpNode) gateOpen[e.id] = 0;
  }
  return { depth, dsalt, ssalt, gateOpen };
}
