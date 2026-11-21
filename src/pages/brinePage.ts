/**
 * 页面 2:纳潮制卤。潮位表开闸、各级卤水深度/波美度网格、闸门实时联动、风吹浓淡条带。
 */
import { store, LiveSnapshot } from '../state/store';
import { FieldCanvas } from '../render/fieldCanvas';
import { el, toast, hourToDate, fmtM3, lineChart } from '../ui/dom';
import { runFullSeason, snapshotAt, setLastHandle } from '../ui/controller';
import { concToBe } from '../sim/units';

export function brinePage(root: HTMLElement) {
  const card = el('div', 'card');
  card.innerHTML = `<h2>纳潮制卤 · 潮位驱动与浓度网格</h2>`;
  const controls = el('div', 'row');
  const runBtn = el('button', 'btn primary', '运行整季仿真');
  const cpuChk = labelCheckbox('强制 CPU 后端', store.settings.forceCpu);
  const windChk = labelCheckbox('风吹浓淡条带', true);
  const progress = el('div', 'progress');
  const pbar = el('div');
  pbar.style.width = '0%';
  progress.append(pbar);
  controls.append(runBtn, cpuChk, windChk, el('span', 'muted', '滚轮缩放 · 拖拽平移 · 点格子看浓度 · 点闸门开关'));
  card.append(controls, progress);

  const wrap = el('div', 'grid2');
  const canvas = el('canvas', 'field') as HTMLCanvasElement;
  const side = el('div');
  wrap.append(canvas, side);
  card.append(wrap);
  root.append(card);

  const fc = new FieldCanvas(
    canvas,
    store.layout,
    {
      showBe: true,
      showSalt: false,
      showGates: true,
      showLabels: false,
      windStreak: windChk.querySelector('input')!.checked,
      snapshot: store.live,
      selected: store.selectedCell,
      bittern: null,
      harvested: null,
      onPickCell: (id) => {
        store.selectedCell = id;
        fc.setOptions({ selected: id });
        renderCell(id);
      },
      onPickGate: (eid) => toggleGate(eid),
    },
  );
  fc.closedGates = new Set(Array.from(store.gateOverride.entries()).filter(([, v]) => !v).map(([k]) => k));

  // 时间轴
  const tlCard = el('div', 'card');
  tlCard.innerHTML = `<h2>时间轴(逐 6 小时快照)</h2>`;
  const slider = el('input') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(store.season.weather.length - 1);
  slider.value = String(store.currentHour);
  slider.className = 'timeline';
  const timeLabel = el('div', 'muted', hourToDate(store.season.startDate, store.currentHour));
  slider.oninput = () => {
    const h = parseInt(slider.value);
    store.currentHour = h;
    timeLabel.textContent = hourToDate(store.season.startDate, h);
    const snap = snapshotAt(h);
    if (snap) {
      store.live = snap;
      fc.setOptions({ snapshot: snap });
      if (store.selectedCell >= 0) renderCell(store.selectedCell);
    }
  };
  tlCard.append(slider, timeLabel);

  // 潮位曲线
  const tideCard = el('div', 'card');
  tideCard.innerHTML = `<h2>潮位表(近 7 日)与纳潮阈值</h2>`;
  const tideCanvas = el('canvas', 'chart') as HTMLCanvasElement;
  tideCard.append(tideCanvas);
  root.append(tlCard, tideCard);
  drawTide(tideCanvas);

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    pbar.style.width = '10%';
    const handle = await runFullSeason((pct, hour) => {
      pbar.style.width = pct + '%';
      timeLabel.textContent = hourToDate(store.season.startDate, hour);
    });
    setLastHandle(handle);
    await handle.promise;
    runBtn.disabled = false;
    const snap = store.live;
    if (snap) fc.setOptions({ snapshot: snap });
    slider.value = String(store.currentHour);
    timeLabel.textContent = hourToDate(store.season.startDate, store.currentHour);
    if (store.selectedCell >= 0) renderCell(store.selectedCell);
  };

  cpuChk.querySelector('input')!.onchange = (e) => {
    store.settings.forceCpu = (e.target as HTMLInputElement).checked;
  };
  windChk.querySelector('input')!.onchange = (e) => {
    fc.setOptions({ windStreak: (e.target as HTMLInputElement).checked });
  };

  function toggleGate(eid: number) {
    const e = store.layout.edges[eid];
    if (!e?.isGate) return toast('固定埝口不可手动开关');
    const cur = store.gateOverride.get(eid) ?? false;
    const next = !cur;
    store.setGate(eid, next);
    if (next) (fc.closedGates as Set<number>).delete(eid);
    else (fc.closedGates as Set<number>).add(eid);
    fc.draw();
    toast(`${e.name} → ${next ? '开' : '关'}(下次运行生效)`);
  }

  function renderCell(id: number) {
    const c = store.layout.cells[id];
    side.innerHTML = '';
    const info = el('div', 'card');
    info.innerHTML = `<h2>${['纳潮库', '蒸发池', '调节池', '结晶池'][c.type]} #${id}</h2>`;
    const snap: LiveSnapshot | null = store.live;
    const depth = snap ? (snap.depth[id] as number) : store.init.depth[id];
    const dsalt = snap ? (snap.dsalt[id] as number) : store.init.dsalt[id];
    const vol = depth * c.area;
    const be = vol > 1e-9 ? concToBe(dsalt / vol) : 0;
    const kpis = el('div', 'grid3');
    kpis.innerHTML = `
      <div class="kpi">${depth.toFixed(2)}<small> m 水深</small></div>
      <div class="kpi">${be.toFixed(1)}<small> °Bé</small></div>
      <div class="kpi">${fmtM3(vol)}<small> 卤水存量</small></div>`;
    info.append(kpis);
    if (snap) {
      const w = store.season.weather[snap.hour] ?? store.season.weather[0];
      info.append(el('table', '', `<tr><th>时刻</th><td>${hourToDate(store.season.startDate, snap.hour)}</td></tr>
        <tr><th>气温/湿度</th><td>${w.t}°C / ${(w.rh * 100).toFixed(0)}%</td></tr>
        <tr><th>风速/日照</th><td>${w.wind} m/s / ${w.rad.toFixed(0)} W/m²</td></tr>
        <tr><th>降雨</th><td>${w.rain} mm/h</td></tr>
        <tr><th>风吹程系数</th><td>${c.windFetch}(下风头浓缩更快)</td></tr>`));
    }
    side.append(info);

    // 下游影响提示
    const downs = store.layout.outgoing[id].map((eid) => store.layout.edges[eid].to).filter((t) => t < store.layout.cellCount);
    if (downs.length) {
      const d = el('div', 'card');
      d.innerHTML = `<h2>下游连通格</h2><p class="muted">开关本格闸门后,下列 ${downs.length} 格浓度将随之变化:</p>`;
      d.append(el('div', '', downs.map((t) => `#${t}`).join(' → ')));
      side.append(d);
    }
  }
}

function labelCheckbox(text: string, checked: boolean) {
  const lab = el('label', 'muted');
  lab.style.display = 'inline-flex';
  lab.style.alignItems = 'center';
  lab.style.gap = '5px';
  lab.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}/> ${text}`;
  return lab;
}

function drawTide(canvas: HTMLCanvasElement) {
  const hours = 168;
  const tide = Array.from({ length: hours }, (_, i) => store.season.tides[i]);
  const thr = Array(hours).fill(store.season.intakeLevel);
  lineChart(canvas, [
    { label: '潮位 m', color: '#2f6f8f', data: tide },
    { label: '纳潮阈值', color: '#d28a2e', data: thr },
  ]);
}
