/**
 * 页面 3:结晶池。盐层厚度生长、俯视/贴地双视角、卤水颜色、苦卤(>30°Bé)标记与排放。
 */
import { store } from '../state/store';
import { FieldCanvas, drawGroundProfile } from '../render/fieldCanvas';
import { el, toast, hourToDate, lineChart, download, fmtKg } from '../ui/dom';
import { snapshotAt } from '../ui/controller';
import { concToBe, SALT_BULK_DENSITY, BITTERN_BE } from '../sim/units';
import { CellType } from '../sim/field';
import { runSeason, DEFAULT_CONFIG } from '../sim/engine';

export function crystalPage(root: HTMLElement) {
  const card = el('div', 'card');
  card.innerHTML = `<h2>结晶池 · 盐层生长与苦卤管理(共 ${store.crystalCells.length} 格)</h2>`;
  const wrap = el('div', 'grid2');
  const canvas = el('canvas', 'field') as HTMLCanvasElement;
  const side = el('div');
  wrap.append(canvas, side);
  card.append(wrap);
  root.append(card);

  const groundCard = el('div', 'card');
  groundCard.innerHTML = `<h2>贴地视角 · 池底起伏与盐板剖面</h2>`;
  const ground = el('canvas', 'ground') as HTMLCanvasElement;
  groundCard.append(ground);
  root.append(groundCard);

  const chartCard = el('div', 'card');
  chartCard.innerHTML = `<h2>选中结晶格 · 全季卤水浓度与盐层曲线</h2>`;
  const chart = el('canvas', 'chart') as HTMLCanvasElement;
  const exportBtn = el('button', 'btn', '导出该格 CSV(含去年同池对比)');
  chartCard.append(chart, el('div', 'row', '', exportBtn));
  root.append(chartCard);

  const bittern = new Uint8Array(store.layout.cellCount);
  const harvested = new Uint8Array(store.layout.cellCount);
  const fc = new FieldCanvas(
    canvas,
    store.layout,
    {
      showBe: true,
      showSalt: true,
      showGates: true,
      showLabels: false,
      windStreak: false,
      snapshot: store.live,
      selected: store.selectedCell,
      bittern,
      harvested,
      onPickCell: (id) => {
        if (store.layout.cells[id].type !== CellType.Crystal) return toast('请选择结晶池格子');
        store.selectedCell = id;
        fc.setOptions({ selected: id });
        renderSide(id);
        drawGroundProfile(ground, store.layout, id, store.live);
        drawChart(id);
      },
      onPickGate: () => void 0,
    },
  );

  function refreshFlags() {
    const snap = store.live;
    if (!snap) return;
    for (const c of store.crystalCells) {
      bittern[c.id] = snap.flags[c.id] & 2 ? 1 : 0;
      harvested[c.id] = snap.flags[c.id] & 4 ? 1 : 0;
    }
    fc.setOptions({ bittern, harvested, snapshot: snap });
  }
  refreshFlags();

  function renderSide(id: number) {
    const c = store.layout.cells[id];
    side.innerHTML = '';
    const info = el('div', 'card');
    info.innerHTML = `<h2>结晶格 #${id}</h2>`;
    const snap = store.live;
    const depth = snap ? (snap.depth[id] as number) : store.init.depth[id];
    const ssalt = snap ? (snap.ssalt[id] as number) : 0;
    const dsalt = snap ? (snap.dsalt[id] as number) : store.init.dsalt[id];
    const vol = depth * c.area;
    const be = vol > 1e-9 ? concToBe(dsalt / vol) : 0;
    const saltMm = (ssalt / SALT_BULK_DENSITY / c.area) * 1000;
    const isBittern = be > BITTERN_BE || bittern[id] === 1;
    info.append(
      el('div', 'grid3', `
      <div class="kpi">${saltMm.toFixed(1)}<small> mm 盐层</small></div>
      <div class="kpi">${be.toFixed(1)}<small> °Bé</small></div>
      <div class="kpi">${fmtKg(ssalt)}<small> 盐板</small></div>`),
    );
    info.append(
      el('table', '', `
      <tr><th>水深</th><td>${depth.toFixed(3)} m</td></tr>
      <tr><th>池底高程</th><td>${c.bottom} m(高低不平见剖面图)</td></tr>
      <tr><th>状态</th><td>${
        isBittern ? '<span class="tag bad">苦卤 · 应排</span>' : harvested[id] ? '<span class="tag good">本季已收</span>' : '<span class="tag warn">在制</span>'
      }</td></tr>
      <tr><th>时刻</th><td>${snap ? hourToDate(store.season.startDate, snap.hour) : '未运行'}</td></tr>`),
    );
    // 苦卤排放
    const sumpEdges = store.layout.edges.filter((e) => e.to === store.layout.sumpNode);
    const drainBtn = el('button', 'btn primary', '打开苦卤排放闸(排走老卤)');
    drainBtn.onclick = () => {
      for (const e of sumpEdges) store.setGate(e.id, true);
      toast(`已开启 ${sumpEdges.length} 处苦卤排放闸,下次运行排走 >30°Bé 老卤`);
    };
    info.append(el('div', 'row', '', drainBtn));
    side.append(info);

    // 苦卤格子清单
    const list = el('div', 'card');
    list.innerHTML = `<h2>苦卤待排格子</h2>`;
    const ids = store.crystalCells.filter((x) => bittern[x.id]).map((x) => x.id);
    list.append(el('p', '', ids.length ? `#${ids.join('、#')}` : '<span class="muted">当前时刻无苦卤格子</span>'));
    side.append(list);
  }

  function drawChart(id: number) {
    const r = store.result;
    if (!r) {
      const ctx = chart.getContext('2d')!;
      ctx.clearRect(0, 0, chart.width, chart.height);
      chartCard.querySelector('.muted')?.remove();
      chartCard.append(el('p', 'muted', '请先在「纳潮制卤」页运行整季仿真'));
      return;
    }
    const hist = r.history.get(id) as { day: number; be: number; saltMm: number }[] | undefined;
    if (!hist) return;
    lineChart(
      chart,
      [
        { label: '波美度 °Bé', color: '#9a5a44', data: hist.map((h) => h.be) },
        { label: '盐层 mm', color: '#2f6f8f', data: hist.map((h) => h.saltMm) },
      ],
      hist.map((h) => `D${h.day}`),
    );
    exportBtn.onclick = () => exportCellCsv(id, hist);
  }

  if (store.selectedCell >= 0 && store.layout.cells[store.selectedCell]?.type === CellType.Crystal) {
    renderSide(store.selectedCell);
    drawGroundProfile(ground, store.layout, store.selectedCell, store.live);
    drawChart(store.selectedCell);
  }

  // 时间轴联动(复用全局快照)
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
      refreshFlags();
      if (store.selectedCell >= 0) {
        renderSide(store.selectedCell);
        drawGroundProfile(ground, store.layout, store.selectedCell, snap);
      }
    }
  };
  card.append(el('div', 'card', ''));
  const tlWrap = card.lastElementChild!;
  tlWrap.append(el('h2', '', '时间轴'), tl, lab);
}

function exportCellCsv(id: number, hist: { day: number; be: number; saltMm: number; depth?: number; ssalt?: number }[]) {
  // 去年同池对比:用独立种子的去年季节在 CPU 上跑(取同格历史)
  const last = runSeason(store.layout, store.init, store.lastSeason, { ...DEFAULT_CONFIG }, [id]);
  const lastHist = last.history.get(id) ?? [];
  const rows = [
    'day,date,this_be,this_salt_mm,last_be,last_salt_mm',
    ...hist.map((h, i) => {
      const lh = lastHist[i];
      const d0 = new Date(store.season.startDate + 'T00:00:00').getTime();
      const date = new Date(d0 + h.day * 86400000).toISOString().slice(0, 10);
      return `${h.day},${date},${h.be},${h.saltMm},${lh ? lh.be : ''},${lh ? lh.saltMm : ''}`;
    }),
  ];
  download(`crystal-cell-${id}-season.csv`, rows.join('\n'));
  toast(`结晶格 #${id} 曲线已导出(含去年同池对比)`);
}
