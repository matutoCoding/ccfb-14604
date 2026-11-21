/**
 * 节点下运行: npx tsx tests/run.ts
 * 验证:盐账/水账守恒(≤1e-3)、暴雨化盐、漫顶、苦卤、收盐、性能。
 */
import { buildLayout, initialState, CellType } from '../src/sim/field';
import { generateSeason, aggregateDays, STORM_START, STORM_END } from '../src/sim/weather';
import { runSeason, DEFAULT_CONFIG, saltLayerMm } from '../src/sim/engine';
import { concToBe } from '../src/sim/units';

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

const t0 = performance.now();
const layout = buildLayout();
const season = generateSeason();
const init = initialState(layout);
const t1 = performance.now();

console.log(`滩田: ${layout.cells.length} 格, ${layout.edges.length} 条闸渠, 构建 ${(t1 - t0).toFixed(1)} ms`);
if (layout.cells.length < 200) throw new Error('测试滩田不得少于 200 格');

// 数据自检
const days = aggregateDays(season);
const stormDays = days.filter((d) => d.rainMm > 50);
console.log(`季长 ${days.length} 天, 暴雨日(>50mm): ${stormDays.map((d) => `${d.date}=${d.rainMm}mm`).join(', ')}`);
if (stormDays.length < 3) throw new Error('必须包含连下三天的暴雨');
if (STORM_END - STORM_START !== 72) throw new Error('暴雨须连续 72 小时');

const crystalIds = layout.cells.filter((c) => c.type === CellType.Crystal).map((c) => c.id);
const t2 = performance.now();
const result = runSeason(layout, init, season, DEFAULT_CONFIG, crystalIds.slice(0, 6));
const t3 = performance.now();

const L = result.ledger;
console.log('\n===== 盐账(kg)=====');
console.log(`期初存量    : ${fmt(L.initialTotal)}`);
console.log(`纳潮进盐    : ${fmt(L.intakeSalt)}`);
console.log(`期末卤水盐  : ${fmt(L.finalDissolved)}`);
console.log(`期末盐板盐  : ${fmt(L.finalSolid)}`);
console.log(`排走(淡+苦): ${fmt(L.drainSalt)}`);
console.log(`漫顶损失    : ${fmt(L.spillSalt)}`);
console.log(`收盐        : ${fmt(L.harvestSalt)}`);
console.log(`盐账绝对误差: ${fmt(L.absErr)} kg  相对误差: ${(L.relErr * 1000).toFixed(5)} ‰`);
console.log(`水账相对误差: ${(L.waterRelErr * 1000).toFixed(5)} ‰ (绝对 ${fmt(L.waterAbsErr)} m³)`);

if (L.relErr > 1e-3) throw new Error(`盐账相对误差 ${L.relErr} 超过千分之一`);
if (L.waterRelErr > 1e-3) throw new Error(`水账相对误差 ${L.waterRelErr} 超过千分之一`);

// 暴雨化盐验证:在"关闭自动收盐"的独立仿真中,暴雨窗口内结晶池盐板总量应显著回溶
const noHarvest = runSeason(layout, initialState(layout), season, { ...DEFAULT_CONFIG, autoHarvest: false }, crystalIds);
const stormDay0 = Math.floor(STORM_START / 24);
let solidBefore = 0;
let solidAfter = 0;
for (const id of crystalIds) {
  const h = noHarvest.history.get(id)!;
  solidBefore += h[stormDay0 - 1]?.ssalt ?? 0;
  solidAfter += h[stormDay0 + 3]?.ssalt ?? 0;
}
console.log(`\n[无抢收] 暴雨前后全结晶区盐板: ${fmt(solidBefore)} → ${fmt(solidAfter)} kg`);
if (!(solidAfter < solidBefore * 0.5)) throw new Error('暴雨应使盐板回溶过半');

// 预警抢收验证:开启自动收盐时,暴雨前盐板应已被抢收(harvestedSalt 在暴雨前有累计)
const beforeStormHarvest = result.harvests
  .filter((h) => h.hour < STORM_START)
  .reduce((s, h) => s + h.saltKg, 0);
console.log(`[抢收] 暴雨前累计收盐 ${fmt(beforeStormHarvest)} kg, 全季收盐 ${fmt(L.harvestSalt)} kg`);
if (beforeStormHarvest <= 0) throw new Error('暴雨预警应触发抢收');

// 漫顶:暴雨窗口应有格子触发漫顶标记(累计漫顶水量 > 0)
const totalSpill = result.counters.spillWater.reduce((s, x) => s + x, 0);
console.log(`全季漫顶水量 ${fmt(totalSpill)} m³`);
if (totalSpill <= 0) throw new Error('特大暴雨应造成至少部分池子漫顶');

// 苦卤标记
const bitternCells = [...result.counters.bitternFlag].filter(Boolean).length;
console.log(`触发苦卤(>30°Bé)标记的格子数: ${bitternCells}`);

// 收盐(预警抢收不受日容量限制,这里只校验常规调度日的容量)
console.log(`\n收盐事件 ${result.harvests.length} 次, 总收盐 ${fmt(L.harvestSalt)} kg`);
const cap = DEFAULT_CONFIG.dailyCapacity;
const perDay = new Map<number, number>();
for (const h of result.harvests) {
  if (!h.auto || h.emergency) continue; // 手动/紧急抢收不受容量约束
  perDay.set(Math.floor(h.hour / 24), (perDay.get(Math.floor(h.hour / 24)) ?? 0) + 1);
}
for (const [, n] of perDay) if (n > cap) throw new Error('常规调度日收盐池数超过容量');

// 结晶池曲线合理性
const tracked = crystalIds[0];
const hist = result.history.get(tracked)!;
const h0 = hist[0];
const hEnd = hist[hist.length - 1];
console.log(`\n结晶格#${tracked}: 季初 Bé=${h0.be} 盐层=${h0.saltMm}mm → 季末 Bé=${hEnd.be} 盐层=${hEnd.saltMm}mm, 采样 ${hist.length} 天`);
if (hist.length !== days.length) throw new Error('历史曲线应每日一条');

// 闸门联动:关闭纳潮闸单独跑 7 天,纳潮量应为 0
const closed = new Map([...layout.edges.filter((e) => e.from === layout.seaNode).map((e) => [e.id, false] as [number, boolean])]);
const r2 = runSeason(layout, initialState(layout), season, { ...DEFAULT_CONFIG, autoHarvest: false, gateOverride: closed, maxHours: 168 }, []);
if (r2.ledger.intakeSalt !== 0) throw new Error('纳潮闸全关时不应有纳潮进盐');
console.log('闸门联动:纳潮闸关闭 7 天进盐 = 0 ✓');

console.log(`\n整季 2880 步 × 230 格 CPU 耗时: ${(t3 - t2).toFixed(0)} ms (要求 < 60000 ms)`);
if (t3 - t2 > 60000) throw new Error('CPU 参考实现超时');
console.log('\n全部测试通过 ✓');
