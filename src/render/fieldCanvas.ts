/**
 * 滩田俯视 Canvas 渲染器:池格、埝埂、闸渠网、卤水浓度/盐层/标记叠加。
 * 支持缩放平移与点击拾取;另提供贴地视角的盐板起伏渲染。
 */
import { FieldLayout, CellType, EdgeDef } from '../sim/field';
import { brineColor, saltColor, FLAG_COLORS, stageColor } from './palette';
import { concToBe } from '../sim/units';
import { LiveSnapshot } from '../state/store';

export interface RenderOptions {
  showBe: boolean; // 按浓度着色
  showSalt: boolean; // 显示盐层
  showGates: boolean;
  showLabels: boolean;
  windStreak: boolean; // 风吹浓淡条带
  snapshot: LiveSnapshot | null;
  selected: number;
  bittern: Uint8Array | null;
  harvested: Uint8Array | null;
  onPickCell?: (id: number) => void;
  onPickGate?: (edgeId: number) => void;
}

export class FieldCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layout: FieldLayout;
  scale = 1;
  offsetX = 20;
  offsetY = 20;
  private opts: RenderOptions;
  private bounds: { minX: number; maxX: number; minY: number; maxY: number };

  constructor(canvas: HTMLCanvasElement, layout: FieldLayout, opts: RenderOptions) {
    this.canvas = canvas;
    this.layout = layout;
    this.opts = opts;
    this.ctx = canvas.getContext('2d')!;
    this.bounds = this.computeBounds();
    this.fit();
    this.attach();
  }

  setOptions(patch: Partial<RenderOptions>) {
    this.opts = { ...this.opts, ...patch };
    this.draw();
  }

  private computeBounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of this.layout.cells) {
      minX = Math.min(minX, c.x - c.w / 2);
      maxX = Math.max(maxX, c.x + c.w / 2);
      minY = Math.min(minY, c.y - c.h / 2);
      maxY = Math.max(maxY, c.y + c.h / 2);
    }
    return { minX, maxX, minY, maxY };
  }

  fit() {
    const w = this.canvas.clientWidth || 900;
    const h = this.canvas.clientHeight || 560;
    const sx = (w - 40) / (this.bounds.maxX - this.bounds.minX);
    const sy = (h - 40) / (this.bounds.maxY - this.bounds.minY);
    this.scale = Math.min(sx, sy);
    this.offsetX = 20 - this.bounds.minX * this.scale;
    this.offsetY = 20 - this.bounds.minY * this.scale;
    this.draw();
  }

  private toScreen(x: number, y: number): [number, number] {
    return [x * this.scale + this.offsetX, y * this.scale + this.offsetY];
  }
  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.offsetX) / this.scale, (py - this.offsetY) / this.scale];
  }

  private attach() {
    let dragging = false;
    let last = { x: 0, y: 0 };
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      this.scale = Math.max(0.05, Math.min(8, this.scale * factor));
      this.offsetX = e.offsetX - wx * this.scale;
      this.offsetY = e.offsetY - wy * this.scale;
      this.draw();
    }, { passive: false });
    this.canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      last = { x: e.offsetX, y: e.offsetY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = this.canvas.getBoundingClientRect();
      this.offsetX += e.clientX - r.left - last.x;
      this.offsetY += e.clientY - r.top - last.y;
      last = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    window.addEventListener('mouseup', () => (dragging = false));
    this.canvas.addEventListener('click', (e) => {
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      const cell = this.pickCell(wx, wy);
      if (cell >= 0) this.opts.onPickCell?.(cell);
      else {
        const edge = this.pickGate(wx, wy);
        if (edge >= 0) this.opts.onPickGate?.(edge);
      }
    });
  }

  private pickCell(wx: number, wy: number): number {
    for (const c of this.layout.cells) {
      if (Math.abs(wx - c.x) <= c.w / 2 && Math.abs(wy - c.y) <= c.h / 2) return c.id;
    }
    return -1;
  }
  private pickGate(wx: number, wy: number): number {
    for (const e of this.layout.edges) {
      const a = e.from < this.layout.cellCount ? this.layout.cells[e.from] : null;
      const b = e.to < this.layout.cellCount ? this.layout.cells[e.to] : null;
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (Math.hypot(wx - mx, wy - my) < 12 / this.scale) return e.id;
    }
    return -1;
  }

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (this.canvas.width !== W * dpr) {
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#e8e2d4';
    ctx.fillRect(0, 0, W, H);

    // 沟渠网(先画,在格子下层)
    ctx.lineWidth = 2;
    for (const e of this.layout.edges) {
      const a = e.from < this.layout.cellCount ? this.layout.cells[e.from] : null;
      const b = e.to < this.layout.cellCount ? this.layout.cells[e.to] : null;
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.y);
      const [x2, y2] = this.toScreen(b.x, b.y);
      ctx.strokeStyle = FLAG_COLORS.channel;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 池格
    const snap = this.opts.snapshot;
    for (const c of this.layout.cells) {
      const [x, y] = this.toScreen(c.x - c.w / 2, c.y - c.h / 2);
      const w = c.w * this.scale;
      const h = c.h * this.scale;
      let fill = stageColor(c.type);
      if (snap) {
        const depth = snap.depth[c.id] as number;
        const vol = depth * c.area;
        const be = vol > 1e-9 ? concToBe((snap.dsalt[c.id] as number) / vol) : 0;
        const ssalt = snap.ssalt[c.id] as number;
        const saltMm = (ssalt / 1200 / c.area) * 1000;
        if (this.opts.showSalt && saltMm > 0.5) {
          fill = saltColor(saltMm, Math.min(1, depth / 0.3));
        } else if (this.opts.showBe && depth > 0.005) {
          fill = brineColor(be, depth);
          if (this.opts.windStreak) {
            // 下风头 windFetch 大、浓缩快:按系数做明暗,形成风吹浓淡条带
            const f = c.windFetch;
            fill = shadeRgb(fill, (f - 1) * 26);
          }
        } else if (depth <= 0.005) {
          fill = '#8d8272'; // 干涸池底
        }
      }
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      // 埝埂
      ctx.strokeStyle = FLAG_COLORS.ridge;
      ctx.lineWidth = Math.max(1, this.scale * 1.2);
      ctx.strokeRect(x, y, w, h);
      // 标记叠加
      if (snap && snap.flags[c.id] & 1) {
        ctx.fillStyle = FLAG_COLORS.overtop;
        ctx.fillRect(x, y, w, h);
      }
      if (this.opts.bittern?.[c.id]) {
        ctx.fillStyle = FLAG_COLORS.bittern;
        ctx.fillRect(x, y, w, h);
      }
      if (this.opts.harvested?.[c.id]) {
        ctx.strokeStyle = FLAG_COLORS.harvested;
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      }
      if (this.opts.selected === c.id) {
        ctx.strokeStyle = '#ffd34d';
        ctx.lineWidth = 3;
        ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
      }
      if (this.opts.showLabels && w > 34 && h > 18) {
        ctx.fillStyle = 'rgba(20,20,20,0.72)';
        ctx.font = '10px system-ui';
        ctx.fillText(String(c.id), x + 3, y + 12);
      }
    }

    // 闸门
    if (this.opts.showGates) {
      for (const e of this.layout.edges) {
        const a = e.from < this.layout.cellCount ? this.layout.cells[e.from] : null;
        const b = e.to < this.layout.cellCount ? this.layout.cells[e.to] : null;
        if (!a || !b || !e.isGate) continue;
        const [gx, gy] = this.toScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
        const open = snap ? true : true;
        void open;
        ctx.fillStyle = this.gateColor(e);
        ctx.beginPath();
        ctx.arc(gx, gy, Math.max(2.5, this.scale * 1.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private gateColor(e: EdgeDef): string {
    const ov = this.opts.snapshot;
    void ov;
    // gateOpen 不在 snapshot 内,由外部状态决定;默认绿,关闭由 store 覆盖(在 page 层传入重绘)
    return this.closedGates.has(e.id) ? FLAG_COLORS.gateClosed : FLAG_COLORS.gateOpen;
  }
  closedGates = new Set<number>();
}

/** 对 rgb(r,g,b) 字符串做 delta 明暗调整 */
function shadeRgb(rgb: string, delta: number): string {
  const m = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return rgb;
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v + delta)));
  return `rgb(${cl(+m[1])},${cl(+m[2])},${cl(+m[3])})`;
}

/**
 * 贴地视角:沿单个结晶池横向剖面画池底起伏、盐板厚度与卤水水面。
 */
export function drawGroundProfile(
  canvas: HTMLCanvasElement,
  layout: FieldLayout,
  cellId: number,
  snap: LiveSnapshot | null,
) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cell = layout.cells[cellId];
  if (!cell) return;
  const depth = snap ? (snap.depth[cellId] as number) : 0;
  const ssalt = snap ? (snap.ssalt[cellId] as number) : 0;
  const saltMm = (ssalt / 1200 / cell.area) * 1000;
  const baseY = H * 0.72;
  const amp = 14; // 池底起伏幅度 px(确定性伪随机)
  // 池底高低不平
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  const pts = 40;
  for (let i = 0; i <= pts; i++) {
    const x = (i / pts) * W;
    const noise = Math.sin(i * 1.7 + cellId) * amp * 0.5 + Math.sin(i * 0.6 + cellId * 2) * amp * 0.5;
    ctx.lineTo(x, baseY + noise);
  }
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = '#7a6a52';
  ctx.fill();
  // 盐板(随厚度抬高)
  const saltH = Math.min(40, saltMm * 0.5);
  ctx.beginPath();
  ctx.moveTo(0, baseY - saltH);
  for (let i = 0; i <= pts; i++) {
    const x = (i / pts) * W;
    const noise = Math.sin(i * 1.7 + cellId) * amp * 0.5 + Math.sin(i * 0.6 + cellId * 2) * amp * 0.5;
    ctx.lineTo(x, baseY + noise - saltH);
  }
  ctx.lineTo(W, baseY);
  ctx.lineTo(0, baseY);
  ctx.closePath();
  ctx.fillStyle = saltColor(saltMm, Math.min(1, depth / 0.3));
  ctx.fill();
  // 卤水水面
  if (depth > 0.005) {
    const waterH = Math.min(H * 0.4, depth * 120);
    const vol = depth * cell.area;
    const be = vol > 1e-9 && snap ? concToBe((snap.dsalt[cellId] as number) / vol) : 0;
    ctx.fillStyle = brineColor(be, depth);
    ctx.globalAlpha = 0.82;
    ctx.fillRect(0, baseY - saltH - waterH, W, waterH);
    ctx.globalAlpha = 1;
  }
  // 标注
  ctx.fillStyle = '#222';
  ctx.font = '12px system-ui';
  ctx.fillText(`结晶格 #${cellId}  水深 ${depth.toFixed(2)}m  盐层 ${saltMm.toFixed(1)}mm`, 10, 18);
  void CellType;
}
