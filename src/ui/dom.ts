/** 通用 UI 工具 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  html = '',
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  for (const ch of children) n.append(ch instanceof Node ? ch : document.createTextNode(ch));
  return n;
}

let toastEl: HTMLDivElement | null = null;
export function toast(msg: string) {
  if (!toastEl) {
    toastEl = el('div', 'toast');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl?.classList.remove('show'), 2600);
}

export function fmtKg(kg: number): string {
  if (kg >= 1e6) return (kg / 1e6).toFixed(2) + ' 千吨';
  if (kg >= 1e3) return (kg / 1e3).toFixed(1) + ' 吨';
  return kg.toFixed(0) + ' kg';
}
export function fmtM3(v: number): string {
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万m³';
  return v.toFixed(0) + ' m³';
}
export function hourToDate(startDate: string, hour: number): string {
  const d0 = new Date(startDate + 'T00:00:00').getTime();
  return new Date(d0 + hour * 3600000).toISOString().slice(5, 16).replace('T', ' ');
}

/** 极简折线图(canvas) */
export function lineChart(canvas: HTMLCanvasElement, series: { label: string; color: string; data: number[] }[], xLabels?: string[]) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 46, r: 12, t: 14, b: 26 };
  const all = series.flatMap((s) => s.data);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const x = (i: number, n: number) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);
  ctx.strokeStyle = '#ccc3b2';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  for (let g = 0; g <= 4; g++) {
    const val = min + ((max - min) * g) / 4;
    const yy = y(val);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(W - pad.r, yy);
    ctx.stroke();
    ctx.fillStyle = '#8a8272';
    ctx.fillText(val.toFixed(max > 100 ? 0 : 1), 4, yy + 3);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const xx = x(i, s.data.length);
      const yy = y(v);
      i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  }
  if (xLabels && xLabels.length) {
    ctx.fillStyle = '#8a8272';
    const step = Math.ceil(xLabels.length / 6);
    for (let i = 0; i < xLabels.length; i += step) ctx.fillText(xLabels[i], x(i, xLabels.length), H - 8);
  }
  // 图例
  let lx = pad.l;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 2, 10, 3);
    ctx.fillStyle = '#5a5346';
    ctx.fillText(s.label, lx + 14, 8);
    lx += ctx.measureText(s.label).width + 34;
  }
}

export function download(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
