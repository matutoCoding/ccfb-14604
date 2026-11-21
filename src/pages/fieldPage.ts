/**
 * 页面 1:滩田布局。实测式网格、池底高程/埝埂、闸门沟渠网、点击查看/编辑属性。
 */
import { store } from '../state/store';
import { FieldCanvas } from '../render/fieldCanvas';
import { el, toast } from '../ui/dom';
import { STAGES, CellType } from '../sim/field';

export function fieldPage(root: HTMLElement) {
  const card = el('div', 'card');
  card.innerHTML = `<h2>滩田布局 · ${store.layout.cells.length} 格 / ${store.layout.edges.length} 条闸渠</h2>`;
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
      showBe: false,
      showSalt: false,
      showGates: true,
      showLabels: true,
      windStreak: false,
      snapshot: null,
      selected: store.selectedCell,
      bittern: null,
      harvested: null,
      onPickCell: (id) => {
        store.selectedCell = id;
        fc.setOptions({ selected: id });
        renderSide(id);
      },
      onPickGate: (eid) => renderGate(eid),
    },
  );

  // 阶段图例与统计
  const legend = el('div', 'card');
  legend.innerHTML = `<h2>级段构成</h2>`;
  const tbl = el('table');
  tbl.innerHTML = `<tr><th>级段</th><th>类型</th><th>格数</th><th>单格面积</th><th>埝埂高</th><th>初始水深/波美</th></tr>`;
  for (let i = 0; i < STAGES.length; i++) {
    const rg = store.layout.stageRanges[i];
    const st = STAGES[i];
    const tr = el('tr');
    tr.innerHTML = `<td>${st.name}</td><td>${typeName(st.type)}</td><td>${rg.end - rg.start}</td><td>${st.area} m²</td><td>${st.ridge} m</td><td>${st.initDepth}m / ${st.initBe}°Bé</td>`;
    tbl.append(tr);
  }
  legend.append(tbl);
  legend.append(
    el('div', 'legend', `<span><i class="swatch" style="background:#2f6f8f"></i>纳潮库</span>
      <span><i class="swatch" style="background:#4a7d5a"></i>蒸发池</span>
      <span><i class="swatch" style="background:#8a7a3a"></i>调节池</span>
      <span><i class="swatch" style="background:#9a5a44"></i>结晶池</span>
      <span><i class="swatch" style="background:#3aa655"></i>闸(开)</span>
      <span><i class="swatch" style="background:#b04438"></i>闸(关)</span>`),
  );
  root.append(legend);

  const resetBtn = el('button', 'btn', '重建实测滩田(重置)');
  resetBtn.onclick = () => {
    store.resetField();
    toast('滩田已重建为 230 格标准测试布局');
    fieldPageRefresh();
  };
  legend.append(el('div', 'row', '', resetBtn));

  function renderSide(id: number) {
    const c = store.layout.cells[id];
    if (!c) return;
    side.innerHTML = '';
    const info = el('div', 'card');
    info.innerHTML = `<h2>格子 #${c.id} 属性</h2>`;
    const rows: [string, string][] = [
      ['所属级段', STAGES[c.stage].name],
      ['类型', typeName(c.type)],
      ['网格行/列', `${c.row} / ${c.col}`],
      ['中心坐标', `${c.x.toFixed(1)}, ${c.y.toFixed(1)} m`],
      ['占地尺寸', `${c.w.toFixed(1)} × ${c.h.toFixed(1)} m`],
      ['池底高程', `${c.bottom} m`],
      ['埝埂高度', `${c.ridge.toFixed(3)} m(相对池底)`],
      ['水面埝顶', `${(c.bottom + c.ridge).toFixed(3)} m`],
      ['单格面积', `${c.area} m²`],
      ['风吹程系数', `${c.windFetch}`],
    ];
    const t = el('table');
    for (const [k, v] of rows) t.append(el('tr', '', `<th>${k}</th><td>${v}</td>`));
    info.append(t);

    // 高程/埝埂可编辑(实测录入)
    const bottomInp = el('input') as HTMLInputElement;
    bottomInp.type = 'number';
    bottomInp.step = '0.01';
    bottomInp.value = String(c.bottom);
    const ridgeInp = el('input') as HTMLInputElement;
    ridgeInp.type = 'number';
    ridgeInp.step = '0.01';
    ridgeInp.value = c.ridge.toFixed(3);
    const save = el('button', 'btn primary', '保存实测值');
    save.onclick = () => {
      c.bottom = parseFloat(bottomInp.value) || c.bottom;
      c.ridge = parseFloat(ridgeInp.value) || c.ridge;
      toast(`格子 #${id} 高程/埝埂已更新`);
    };
    info.append(el('div', 'row', '<label>池底高程</label>'), bottomInp, el('div', 'row', '<label>埝埂高</label>'), ridgeInp, save);
    side.append(info);

    // 相连闸渠
    const conns = el('div', 'card');
    conns.innerHTML = `<h2>相连闸渠</h2>`;
    const ct = el('table');
    ct.innerHTML = `<tr><th>闸/渠</th><th>方向</th><th>宽</th><th>堰顶</th></tr>`;
    for (const eid of [...store.layout.incoming[c.id], ...store.layout.outgoing[c.id]]) {
      const e = store.layout.edges[eid];
      ct.append(el('tr', '', `<td>${e.name}</td><td>${e.from}→${e.to}</td><td>${e.width}m</td><td>${e.invert}m</td>`));
    }
    conns.append(ct);
    side.append(conns);
  }

  function renderGate(eid: number) {
    const e = store.layout.edges[eid];
    side.innerHTML = '';
    const g = el('div', 'card');
    g.innerHTML = `<h2>${e.name}</h2>`;
    g.append(el('table', '', `<tr><th>连接</th><td>${e.from} → ${e.to}</td></tr>
      <tr><th>闸/渠宽</th><td>${e.width} m</td></tr><tr><th>堰顶高程</th><td>${e.invert} m</td></tr>
      <tr><th>类型</th><td>${e.isGate ? '可控闸门' : '固定埝口'}</td></tr>`));
    if (e.isGate) {
      const cur = store.gateOverride.get(eid);
      const openBtn = el('button', 'btn blue', '手动开闸');
      const closeBtn = el('button', 'btn', '手动关闸');
      const autoBtn = el('button', 'btn', '恢复自动');
      openBtn.onclick = () => { store.setGate(eid, true); fc.closedGates.delete(eid); fc.draw(); toast(`${e.name} 已开启`); };
      closeBtn.onclick = () => { store.setGate(eid, false); fc.closedGates.add(eid); fc.draw(); toast(`${e.name} 已关闭`); };
      autoBtn.onclick = () => { store.gateOverride.delete(eid); fc.closedGates.delete(eid); fc.draw(); toast(`${e.name} 恢复自动调度`); };
      g.append(el('div', 'row', '', openBtn, closeBtn, autoBtn), el('p', 'muted', `当前手动覆盖:${cur === undefined ? '自动' : cur ? '开' : '关'}`));
    }
    side.append(g);
  }

  function fieldPageRefresh() {
    root.innerHTML = '';
    fieldPage(root);
  }
  void fieldPageRefresh;
}

function typeName(t: CellType) {
  return ['纳潮库', '蒸发池', '调节池', '结晶池'][t];
}
