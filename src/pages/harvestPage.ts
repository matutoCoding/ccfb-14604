/**
 * 页面 5:收盐调度。按盐层厚度与预报排产、收盐机路线、日容量、预警抢收、产量/浓度导出。
 */
import { store } from '../state/store';
import { FieldCanvas } from '../render/fieldCanvas';
import { el, toast, hourToDate, lineChart, download, fmtKg } from '../ui/dom';
import { snapshotAt } from '../ui/controller';
import { SALT_BULK_DENSITY } from '../sim/units';
import { CellType } from '../sim/field';

export function harvestPage(root: HTMLElement) {
  const card = el('div', 'card');
  card.innerHTML = `<h2>收盐调度 · 排产与收盐机路线</h2>`;
  const wrap = el('div', 'grid2');
  const canvas = el('canvas', 'field') as HTMLCanvasElement;
  const side = el('div');
  wrap.append(canvas, side);
  card.append(wrap);
  root.append(card);

  const harvested = new Uint8Array(store.layout.cellCount);
  const fc = new FieldCanvas(
    canvas,
    store.layout,
    {
      showBe: false,
      showSalt: true,
      showGates: true,
      showLabels: false,
      windStreak: false,
      snapshot: store.live,
      selected: -1,
      bittern: null,
      harvested,
      onPickCell: () => void 0,
      onPickGate: () => void 0,
    },
  );

  // 排产参数
  const paramCard = el('div', 'card');
  paramCard.innerHTML = `<h2>排产参数</h2>`;
  const mmInp = el('input') as HTMLInputElement;
  mmInp.type = 'number';
  mmInp.value = String(store.settings.harvestSaltMm);
  const capInp = el('input') as HTMLInputElement;
  capInp.type = 'number';
  capInp.value = String(store.settings.dailyCapacity);
  const save = el('button', 'btn primary', '保存参数');
  save.onclick = () => {
    store.settings.harvestSaltMm = parseFloat(mmInp.value) || 60;
    store.settings.dailyCapacity = parseInt(capInp.value) || 3;
    store.persist();
    toast('排产参数已保存并写入 IndexedDB');
  };
  paramCard.append(
    el('div', 'row', '<label>触发收盐盐层厚度 mm</label>', mmInp, '<label>每日可收池数</label>', capInp, save),
    el('p', 'muted', '暴雨预警(未来 24h 雨量 >60mm)触发紧急抢收,不受日容量限制。'),
  );
  root.append(paramCard);

  // 排产表
  const tableCard = el('div', 'card');
  tableCard.innerHTML = `<h2>结晶池盐层排序(当前时刻)</h2>`;
  const tbl = el('table');
  tbl.innerHTML = `<tr><th>池号</th><th>盐层 mm</th><th>盐板量</th><th>状态</th><th>建议</th></tr>`;
  const scroll = el('div', 'scroll');
  scroll.append(tbl);
  tableCard.append(scroll);
  root.append(tableCard);

  // 产量曲线
  const chartCard = el('div', 'card');
  chartCard.innerHTML = `<h2>全季收盐产量与盐账</h2>`;
  const chart = el('canvas', 'chart') as HTMLCanvasElement;
  const exportAll = el('button', 'btn', '导出全部结晶池产量/浓度曲线 CSV');
  chartCard.append(chart, el('div', 'row', '', exportAll));
  root.append(chartCard);

  refreshTable();
  refreshHarvested();
  drawRoute();
  drawProduction();

  function cellSaltMm(id: number): { mm: number; kg: number } {
    const snap = store.live;
    const c = store.layout.cells[id];
    const kg = snap ? (snap.ssalt[id] as number) : 0;
    return { mm: (kg / SALT_BULK_DENSITY / c.area) * 1000, kg };
  }

  function refreshTable() {
    tbl.innerHTML = `<tr><th>池号</th><th>盐层 mm</th><th>盐板量</th><th>状态</th><th>建议</th></tr>`;
    const rows = store.crystalCells
      .map((c) => ({ id: c.id, ...cellSaltMm(c.id), done: harvested[c.id] === 1 }))
      .sort((a, b) => b.mm - a.mm);
    const cap = store.settings.dailyCapacity;
    let rank = 0;
    for (const r of rows) {
      const tr = el('tr');
      const advise = r.done ? '已收' : r.mm >= store.settings.harvestSaltMm && rank < cap ? '今日收' : r.mm >= store.settings.harvestSaltMm ? '排队' : '继续结晶';
      if (advise === '今日收') rank++;
      tr.innerHTML = `<td>#${r.id}</td><td>${r.mm.toFixed(1)}</td><td>${fmtKg(r.kg)}</td>
        <td>${r.done ? '<span class="tag good">已收</span>' : '<span class="tag warn">在制</span>'}</td>
        <td>${advise}</td>`;
      tbl.append(tr);
    }
  }

  function refreshHarvested() {
    const snap = store.live;
    if (!snap) return;
    for (const c of store.crystalCells) harvested[c.id] = snap.flags[c.id] & 4 ? 1 : 0;
    fc.setOptions({ harvested, snapshot: snap });
  }

  /** 收盐机路线:按盐层厚度从厚到薄、就近蛇形,画在滩面上 */
  function drawRoute() {
    const ctx = canvas.getContext('2d')!;
    const snap = store.live;
    if (!snap) return;
    const targets = store.crystalCells
      .map((c) => ({ id: c.id, ...cellSaltMm(c.id), c }))
      .filter((r) => r.mm >= store.settings.harvestSaltMm && !harvested[r.id])
      .sort((a, b) => b.mm - a.mm)
      .slice(0, store.settings.dailyCapacity);
    if (!targets.length) return;
    // 蛇形就近:按列再按行
    targets.sort((a, b) => a.c.col - b.c.col || a.c.row - b.c.row);
    ctx.save();
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    targets.forEach((r, i) => {
      // 借用 FieldCanvas 的变换:重新计算屏幕坐标
      const sx = r.c.x * fc.scale + fc.offsetX;
      const sy = r.c.y * fc.scale + fc.offsetY;
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // 序号
    targets.forEach((r, i) => {
      const sx = r.c.x * fc.scale + fc.offsetX;
      const sy = r.c.y * fc.scale + fc.offsetY;
      ctx.fillStyle = '#b8860b';
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), sx, sy + 4);
      ctx.textAlign = 'start';
    });
    ctx.restore();
    side.innerHTML = '';
    const sum = el('div', 'card');
    sum.innerHTML = `<h2>今日收盐路线</h2>`;
    sum.append(el('p', '', `收盐机依次收 #${targets.map((t) => t.id).join(' → #')}`), el('p', 'muted', `共 ${targets.length} 池,合计 ${fmtKg(targets.reduce((s, t) => s + t.kg, 0))}`));
    side.append(sum);
  }

  function drawProduction() {
    const r = store.result;
    if (!r) {
      const ctx = chart.getContext('2d')!;
      ctx.clearRect(0, 0, chart.width, chart.height);
      return;
    }
    // 按日累计收盐
    const days = new Map<number, number>();
    for (const h of r.harvests) {
      const d = Math.floor(h.hour / 24);
      days.set(d, (days.get(d) ?? 0) + h.saltKg);
    }
    const maxDay = r.hours / 24;
    const cum: number[] = [];
    let acc = 0;
    const labels: string[] = [];
    for (let d = 0; d < maxDay; d++) {
      acc += days.get(d) ?? 0;
      cum.push(acc / 1000); // 吨
      labels.push(`D${d}`);
    }
    lineChart(chart, [{ label: '累计收盐 吨', color: '#9a5a44', data: cum }], labels);
    // KPI
    const L = r.ledger;
    const kpi = el('div', 'grid4');
    kpi.innerHTML = `
      <div class="kpi">${fmtKg(L.harvestSalt)}<small> 总收盐</small></div>
      <div class="kpi">${(L.relErr * 1000).toFixed(3)}<small> ‰ 盐账误差</small></div>
      <div class="kpi">${r.harvests.length}<small> 次收盐事件</small></div>
      <div class="kpi">${r.elapsedMs?.toFixed(0) ?? '-'}<small> ms 耗时(${r.backend})</small></div>`;
    chartCard.append(kpi);
    exportAll.onclick = () => exportAllCsv();
  }

  function exportAllCsv() {
    const r = store.result;
    if (!r) return toast('请先运行整季仿真');
    const header = 'cell_id,day,date,be,salt_mm,salt_kg,depth_m';
    const lines = [header];
    const d0 = new Date(store.season.startDate + 'T00:00:00').getTime();
    for (const id of store.crystalCells.map((c) => c.id)) {
      const hist = r.history.get(id) as { day: number; be: number; saltMm: number; ssalt: number; depth: number }[] | undefined;
      if (!hist) continue;
      for (const h of hist) {
        const date = new Date(d0 + h.day * 86400000).toISOString().slice(0, 10);
        lines.push(`${id},${h.day},${date},${h.be},${h.saltMm},${h.ssalt},${h.depth}`);
      }
    }
    download('crystal-all-cells-season.csv', lines.join('\n'));
    toast('全部结晶池产量/浓度曲线已导出 CSV');
  }

  // 时间轴
  const tl = el('input') as HTMLInputElement;
  tl.type = 'range';
  tl.min = '0';
  tl.max = String(store.season.weather.length - 1);
  tl.value = String(store.currentHour);
  tl.className = 'timeline';
  const lab = el('div', 'muted', hourToDate(store.season.startDate, store.currentHour));
  tl.oninput = () => {
    const h = parseInt(tl.value);
    store.currentHour = h;
    lab.textContent = hourToDate(store.season.startDate, h);
    const snap = snapshotAt(h);
    if (snap) {
      store.live = snap;
      refreshHarvested();
      refreshTable();
      drawRoute();
    }
  };
  card.append(el('div', 'card', ''));
  card.lastElementChild!.append(el('h2', '', '时间轴'), tl, lab);
  void CellType;
}
