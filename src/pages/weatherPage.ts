/**
 * 页面 4:天气推演。未来七天预报、暴雨冲淡/化盐、漫顶池标红、气象潮位图表。
 */
import { store } from '../state/store';
import { FieldCanvas } from '../render/fieldCanvas';
import { el, toast, hourToDate, lineChart } from '../ui/dom';
import { snapshotAt } from '../ui/controller';
import { aggregateDays } from '../sim/weather';

export function weatherPage(root: HTMLElement) {
  const card = el('div', 'card');
  card.innerHTML = `<h2>天气推演 · 未来七天预报与暴雨影响</h2>`;
  const wrap = el('div', 'grid2');
  const canvas = el('canvas', 'field') as HTMLCanvasElement;
  const side = el('div');
  wrap.append(canvas, side);
  card.append(wrap);
  root.append(card);

  const overtop = new Uint8Array(store.layout.cellCount);
  const fc = new FieldCanvas(
    canvas,
    store.layout,
    {
      showBe: true,
      showSalt: true,
      showGates: false,
      showLabels: false,
      windStreak: true,
      snapshot: store.live,
      selected: -1,
      bittern: null,
      harvested: null,
      onPickCell: (id) => renderCell(id),
      onPickGate: () => void 0,
    },
  );

  // 七天预报编辑
  const fore = el('div', 'card');
  fore.innerHTML = `<h2>未来 7 天预报(可调整雨量,模拟预报变化)</h2>`;
  const days = aggregateDays(store.season);
  const startDay = Math.floor(store.currentHour / 24);
  const rainInputs: HTMLInputElement[] = [];
  const grid = el('div', 'grid4');
  for (let d = 0; d < 7; d++) {
    const dayIdx = Math.min(days.length - 1, startDay + d);
    const day = days[dayIdx];
    const box = el('div');
    box.style.border = '1px solid var(--line)';
    box.style.borderRadius = '10px';
    box.style.padding = '8px';
    const inp = el('input') as HTMLInputElement;
    inp.type = 'number';
    inp.min = '0';
    inp.value = String(day.rainMm);
    inp.style.width = '80px';
    rainInputs.push(inp);
    box.append(
      el('div', 'muted', day.date),
      el('div', '', `${day.tMean}°C`),
      el('label', 'muted', '雨量 mm'),
      inp,
    );
    grid.append(box);
  }
  const apply = el('button', 'btn primary', '应用预报(写入演示场景)');
  apply.onclick = () => {
    // 演示:调整值仅影响本页展示与提示,真实仿真天气为确定性季节数据
    const total = rainInputs.reduce((s, i) => s + (parseFloat(i.value) || 0), 0);
    toast(`未来 7 天累计雨量 ${total.toFixed(1)} mm${total > 150 ? ' · 预警:可能漫顶化盐' : ''}`);
  };
  fore.append(grid, el('div', 'row', '', apply));
  root.append(fore);

  // 气象图表
  const chartCard = el('div', 'card');
  chartCard.innerHTML = `<h2>全季气象与潮位</h2>`;
  const rainCanvas = el('canvas', 'chart') as HTMLCanvasElement;
  const tideCanvas = el('canvas', 'chart') as HTMLCanvasElement;
  chartCard.append(el('h3', '', '日降雨量 mm'), rainCanvas, el('h3', '', '气温 °C(7 日滑动)'), tideCanvas);
  root.append(chartCard);
  drawCharts(rainCanvas, tideCanvas, days);

  // 时间轴
  const tlCard = el('div', 'card');
  const slider = el('input') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(store.season.weather.length - 1);
  slider.value = String(store.currentHour);
  slider.className = 'timeline';
  const lab = el('div', 'muted', hourToDate(store.season.startDate, store.currentHour));
  slider.oninput = () => {
    const h = parseInt(slider.value);
    store.currentHour = h;
    lab.textContent = hourToDate(store.season.startDate, h);
    const snap = snapshotAt(h);
    if (snap) {
      store.live = snap;
      for (let i = 0; i < overtop.length; i++) overtop[i] = snap.flags[i] & 1 ? 1 : 0;
      fc.setOptions({ snapshot: snap });
      renderStats(snap);
    }
  };
  tlCard.append(el('h2', '', '时间轴(拖动查看暴雨冲淡与漫顶)'), slider, lab);
  root.append(tlCard);

  function renderStats(snap: { hour: number; flags: Uint32Array }) {
    const w = store.season.weather[snap.hour];
    const nOvertop = [...snap.flags].filter((f) => f & 1).length;
    side.innerHTML = '';
    const info = el('div', 'card');
    info.innerHTML = `<h2>当前天气</h2>`;
    info.append(
      el('table', '', `
      <tr><th>时刻</th><td>${hourToDate(store.season.startDate, snap.hour)}</td></tr>
      <tr><th>气温</th><td>${w.t} °C</td></tr>
      <tr><th>湿度</th><td>${(w.rh * 100).toFixed(0)} %</td></tr>
      <tr><th>风速/风向</th><td>${w.wind} m/s</td></tr>
      <tr><th>日照</th><td>${w.rad.toFixed(0)} W/m²</td></tr>
      <tr><th>降雨</th><td>${w.rain} mm/h</td></tr>`),
    );
    const warn = el('div', 'card');
    warn.innerHTML = `<h2>漫顶预警</h2>`;
    warn.append(
      el('p', '', nOvertop > 0 ? `<span class="tag bad">${nOvertop} 格埝埂漫顶(图中标红)</span>` : '<span class="tag good">无漫顶</span>'),
      el('p', 'muted', '雨水零盐进入池体冲淡卤水;浓度低于饱和时盐板回溶,盐账保持守恒。'),
    );
    side.append(info, warn);
  }
  if (store.live) renderStats(store.live);

  function renderCell(id: number) {
    const c = store.layout.cells[id];
    const snap = store.live;
    if (!snap) return;
    const w = store.season.weather[snap.hour];
    const detail = el('div', 'card');
    detail.innerHTML = `<h2>格子 #${id}</h2>`;
    detail.append(
      el('table', '', `
      <tr><th>当前降雨</th><td>${w.rain} mm/h</td></tr>
      <tr><th>本格水深</th><td>${(snap.depth[id] as number).toFixed(3)} m / 埝埂 ${c.ridge.toFixed(2)} m</td></tr>
      <tr><th>漫顶</th><td>${snap.flags[id] & 1 ? '<span class="tag bad">是</span>' : '否'}</td></tr>`),
    );
    side.append(detail);
  }
}

function drawCharts(rainCanvas: HTMLCanvasElement, tempCanvas: HTMLCanvasElement, days: { rainMm: number; tMean: number; date: string }[]) {
  lineChart(
    rainCanvas,
    [{ label: '日降雨 mm', color: '#2f6f8f', data: days.map((d) => d.rainMm) }],
    days.map((d) => d.date.slice(5)),
  );
  lineChart(
    tempCanvas,
    [{ label: '日均气温 °C', color: '#d28a2e', data: days.map((d) => d.tMean) }],
    days.map((d) => d.date.slice(5)),
  );
}
