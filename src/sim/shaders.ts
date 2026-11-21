/**
 * WGSL 计算着色器:与 src/sim/engine.ts 的 CPU 公式逐式对照。
 * 4 个打包 storage buffer(dyn/static/edge/counter)+ 1 uniform,满足设备
 * maxStorageBuffersPerShaderStage=10 限制。四个 pass:gate→edge→cell→harvest。
 */
import { wgslTables } from './units';

export const WORKGROUP = 64;

export function wgslCommon(): string {
  return /* wgsl */ `
struct Params {
  nCells: f32, nEdges: f32, hour: f32, maxHours: f32,
  tide: f32, temp: f32, rh: f32, wind: f32, rad: f32, rain: f32,
  rainAhead: f32, intakeLevel: f32, seaNode: f32, sumpNode: f32,
  autoHarvest: f32, harvestSaltMm: f32, dailyCapacity: f32, rain24: f32, pad1: f32, pad2: f32,
}
@group(0) @binding(0) var<uniform> P: Params;
// dynBuf: 6 区块 × N: 0 depth,1 dsalt,2 ssalt,3 dWater,4 dSalt,5 brineAge
@group(0) @binding(1) var<storage, read_write> dynBuf: array<f32>;
// prevBuf: 2 区块 × N: 0 prevDepth,1 prevDsalt(独立缓冲以便 copyBufferToBuffer)
@group(0) @binding(2) var<storage, read_write> prevBuf: array<f32>;
// staticBuf: 6 区块 × N: 0 bottom,1 ridge,2 area,3 windFetch,4 cellType(u32),5 outDegree(u32)
@group(0) @binding(3) var<storage> staticBuf: array<f32>;
// edgeBuf: 8 区块 × E: 0 from,1 to,2 width,3 invert,4 isGate,5 gateOpen,6 fluxQ,7 fluxQSalt
@group(0) @binding(4) var<storage, read_write> edgeBuf: array<f32>;
// linkBuf: 邻接表。布局:inCount(N)、outCount(N)、inEdges(不定,每格最多 LK)、outEdges
// 用固定每格 LK 槽: inBase=2N, outBase=2N+N*LK
@group(0) @binding(6) var<storage> linkBuf: array<f32>;
// counterBuf: 9 区块×N 计数器, 再 flags(N)、harvest(1+3072)、reduce
@group(0) @binding(5) var<storage, read_write> counterBuf: array<f32>;

fn dIdx(blk: u32, i: u32) -> u32 { return blk * u32(P.nCells) + i; }
fn pIdx(blk: u32, i: u32) -> u32 { return blk * u32(P.nCells) + i; }
fn sIdx(blk: u32, i: u32) -> u32 { return blk * u32(P.nCells) + i; }
fn eIdx(blk: u32, ei: u32) -> u32 { return blk * u32(P.nEdges) + ei; }
fn cIdx(blk: u32, i: u32) -> u32 { return blk * u32(P.nCells) + i; }
fn flagIdx(i: u32) -> u32 { return 9u * u32(P.nCells) + i; }
fn harvestBase() -> u32 { return 10u * u32(P.nCells); }

fn getDepth(i: u32) -> f32 { return dynBuf[dIdx(0u,i)]; }
fn getDsalt(i: u32) -> f32 { return dynBuf[dIdx(1u,i)]; }
fn getSsalt(i: u32) -> f32 { return dynBuf[dIdx(2u,i)]; }
fn getPrevDepth(i: u32) -> f32 { return prevBuf[pIdx(0u,i)]; }
fn getPrevDsalt(i: u32) -> f32 { return prevBuf[pIdx(1u,i)]; }
fn getDWater(i: u32) -> f32 { return dynBuf[dIdx(3u,i)]; }
fn getDSalt(i: u32) -> f32 { return dynBuf[dIdx(4u,i)]; }
fn getBrineAge(i: u32) -> f32 { return dynBuf[dIdx(5u,i)]; }
fn setDyn(blk: u32, i: u32, v: f32) { dynBuf[dIdx(blk,i)] = v; }
fn addDyn(blk: u32, i: u32, v: f32) { dynBuf[dIdx(blk,i)] = dynBuf[dIdx(blk,i)] + v; }

fn cellBottom(i: u32) -> f32 { return staticBuf[sIdx(0u,i)]; }
fn cellRidge(i: u32) -> f32 { return staticBuf[sIdx(1u,i)]; }
fn cellArea(i: u32) -> f32 { return staticBuf[sIdx(2u,i)]; }
fn cellWindFetch(i: u32) -> f32 { return staticBuf[sIdx(3u,i)]; }
fn cellTypeOf(i: u32) -> u32 { return bitcast<u32>(staticBuf[sIdx(4u,i)]); }
fn outDegree(i: u32) -> u32 { return bitcast<u32>(staticBuf[sIdx(5u,i)]); }

fn edgeFrom(ei: u32) -> u32 { return bitcast<u32>(edgeBuf[eIdx(0u,ei)]); }
fn edgeTo(ei: u32) -> u32 { return bitcast<u32>(edgeBuf[eIdx(1u,ei)]); }
fn edgeWidth(ei: u32) -> f32 { return edgeBuf[eIdx(2u,ei)]; }
fn edgeInvert(ei: u32) -> f32 { return edgeBuf[eIdx(3u,ei)]; }
fn edgeIsGate(ei: u32) -> u32 { return bitcast<u32>(edgeBuf[eIdx(4u,ei)]); }
fn gateOpen(ei: u32) -> u32 { return bitcast<u32>(edgeBuf[eIdx(5u,ei)]); }
fn setGateOpen(ei: u32, v: u32) { edgeBuf[eIdx(5u,ei)] = bitcast<f32>(v); }
fn edgeQ(ei: u32) -> f32 { return edgeBuf[eIdx(6u,ei)]; }
fn edgeQSalt(ei: u32) -> f32 { return edgeBuf[eIdx(7u,ei)]; }
fn setEdgeQ(ei: u32, q: f32) { edgeBuf[eIdx(6u,ei)] = q; }
fn setEdgeQSalt(ei: u32, q: f32) { edgeBuf[eIdx(7u,ei)] = q; }

// 邻接:每格最多 16 条入/出边
const LK: u32 = 16u;
fn inCount(i: u32) -> u32 { return bitcast<u32>(linkBuf[i]); }
fn outCount(i: u32) -> u32 { return bitcast<u32>(linkBuf[u32(P.nCells) + i]); }
fn inEdge(i: u32, k: u32) -> u32 { return bitcast<u32>(linkBuf[2u * u32(P.nCells) + i * LK + k]); }
fn outEdge(i: u32, k: u32) -> u32 { return bitcast<u32>(linkBuf[2u * u32(P.nCells) + u32(P.nCells) * LK + i * LK + k]); }

fn addCtr(blk: u32, i: u32, v: f32) { counterBuf[cIdx(blk,i)] = counterBuf[cIdx(blk,i)] + v; }
fn getFlag(i: u32) -> u32 { return bitcast<u32>(counterBuf[flagIdx(i)]); }
fn setFlag(i: u32, bits: u32) { counterBuf[flagIdx(i)] = bitcast<f32>(getFlag(i) | bits); }
fn clearFlag(i: u32, bits: u32) { counterBuf[flagIdx(i)] = bitcast<f32>(getFlag(i) & ~bits); }
fn harvestCnt() -> u32 { return bitcast<u32>(counterBuf[harvestBase()]); }
fn setHarvestCnt(v: u32) { counterBuf[harvestBase()] = bitcast<f32>(v); }
fn setHarvest(k: u32, off: u32, v: u32) { counterBuf[harvestBase() + 1u + k * 3u + off] = bitcast<f32>(v); }

fn cellHead(i: u32) -> f32 { return cellBottom(i) + getPrevDepth(i); }
fn boundaryHead(node: u32, invert: f32) -> f32 {
  if (node == u32(P.seaNode)) { return P.tide; }
  return invert - 0.5;
}
`;
}

/** Pass gate:闸门调度(每边一个线程) */
export function gateShader(): string {
  return wgslTables() + wgslCommon() + /* wgsl */ `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ei = gid.x;
  if (f32(ei) >= P.nEdges) { return; }
  let srcNode = edgeFrom(ei);
  let dstNode = edgeTo(ei);
  let n = u32(P.nCells);
  let storm = P.rain > 3.0 || P.rainAhead > 30.0;
  if (srcNode == u32(P.seaNode)) {
    var open = 0u;
    if (!storm && P.tide >= P.intakeLevel && getPrevDepth(dstNode) < cellRidge(dstNode) * 0.85) { open = 1u; }
    setGateOpen(ei, open);
  } else if (dstNode == u32(P.seaNode)) {
    setGateOpen(ei, 1u);
  } else if (edgeIsGate(ei) == 1u && dstNode < n) {
    // 迟滞:低于 low 开、高于 high 关,中间保持原状态(与 CPU 批式轮转一致);读上小时状态
    let ridge = cellRidge(dstNode);
    let low = ridge * select(0.28, 0.15, storm);
    let high = ridge * select(0.52, 0.4, storm);
    if (getPrevDepth(dstNode) < low) { setGateOpen(ei, 1u); }
    else if (getPrevDepth(dstNode) > high) { setGateOpen(ei, 0u); }
  }}
`;
}

/** Pass edge:闸渠汇流(每条边一个线程,Jacobi 读 prev) */
export function edgeShader(): string {
  return wgslTables() + wgslCommon() + /* wgsl */ `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ei = gid.x;
  if (f32(ei) >= P.nEdges) { return; }
  // 每步先清零本边通量,避免提前 return 时残留上小时的 q
  setEdgeQ(ei, 0.0);
  setEdgeQSalt(ei, 0.0);
  if (gateOpen(ei) == 0u) { return; }
  let srcNode = edgeFrom(ei);
  let dstNode = edgeTo(ei);
  let n = u32(P.nCells);
  let hFrom = select(boundaryHead(srcNode, edgeInvert(ei)), cellHead(srcNode), srcNode < n);
  let hTo = select(boundaryHead(dstNode, edgeInvert(ei)), cellHead(dstNode), dstNode < n);
  let dh = hFrom - hTo;
  if (dh <= 0.005) { return; }
  var q = WEIR_COEF * edgeWidth(ei) * pow(clamp(dh, 0.0, 10000.0), 1.5) * SECS_PER_HOUR;
  var concFrom = 0.0;
  if (srcNode >= n) {
    concFrom = select(0.0, SEA_CONC, srcNode == u32(P.seaNode));
  } else {
    let vol = max(0.000000001, getPrevDepth(srcNode) * cellArea(srcNode));
    concFrom = getPrevDsalt(srcNode) / vol;
    let avail = getPrevDepth(srcNode) * cellArea(srcNode);
    let limit = (avail * 0.5) / f32(max(1u, outDegree(srcNode)));
    if (q > limit) { q = limit; }
  }
  let qSalt = q * concFrom;
  // 只写本边独占槽位,避免多线程对同一格子的读-改-写竞态
  setEdgeQ(ei, q);
  setEdgeQSalt(ei, qSalt);
  // 边界计数器:每个真实格子的边界边唯一,无并发冲突
  if (srcNode == u32(P.seaNode) && dstNode < n) { addCtr(5u, dstNode, q); addCtr(0u, dstNode, q * SEA_CONC); }
  if (dstNode == u32(P.seaNode) && srcNode < n) { addCtr(6u, srcNode, q); addCtr(1u, srcNode, qSalt); }
  if (dstNode == u32(P.sumpNode) && srcNode < n) { addCtr(6u, srcNode, q); addCtr(1u, srcNode, qSalt); }
}
`;
}

/** Pass cell:格子物理更新(每格一个线程) */
export function cellShader(): string {
  return wgslTables() + wgslCommon() + /* wgsl */ `
fn evapMm(t: f32, rh: f32, u: f32, rad: f32) -> f32 {
  let e = 0.2 * (0.6 + 0.04 * t) * max(0.05, 1.0 - rh) * (0.5 + 0.12 * u) * (0.35 + rad / 900.0);
  return clamp(e, 0.0, 1.0);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (f32(i) >= P.nCells) { return; }
  let bottom = cellBottom(i);
  let ridge = cellRidge(i);
  let area = cellArea(i);
  let windFetch = cellWindFetch(i);
  // 漫顶标记锁存:一旦漫顶本季保持(便于时间轴回放观察),不逐时清除

  // 串行归约本格入/出边通量(单线程,无并发冲突),等价 CPU 的 dWater/dSalt 净累积
  var netQ = 0.0;
  var netQSalt = 0.0;
  for (var k = 0u; k < inCount(i); k++) {
    let ei = inEdge(i, k);
    netQ = netQ + edgeQ(ei);
    netQSalt = netQSalt + edgeQSalt(ei);
  }
  for (var k2 = 0u; k2 < outCount(i); k2++) {
    let eo = outEdge(i, k2);
    netQ = netQ - edgeQ(eo);
    netQSalt = netQSalt - edgeQSalt(eo);
  }

  var vol = getPrevDepth(i) * area + netQ;
  var salt = getPrevDsalt(i) + netQSalt;
  if (vol < 0.0) { vol = 0.0; }
  if (salt < 0.0) { salt = 0.0; }

  let rainVol = (P.rain / 1000.0) * area;
  if (rainVol > 0.0) { vol = vol + rainVol; addCtr(3u, i, rainVol); }

  var eMm = evapMm(P.temp, P.rh, P.wind, P.rad) * windFetch;
  var evapVol = min(eMm, 1.4) / 1000.0 * area;
  evapVol = min(evapVol, vol);
  vol = vol - evapVol;
  addCtr(4u, i, evapVol);

  let ridgeTop = bottom + ridge;
  let depthNow = vol / area;
  if (bottom + depthNow > ridgeTop) {
    let spillV = (bottom + depthNow - ridgeTop) * area;
    var cNow = 0.0;
    if (vol > 0.000000001) { cNow = salt / vol; }
    vol = vol - spillV;
    salt = salt - spillV * cNow;
    addCtr(7u, i, spillV);
    addCtr(2u, i, spillV * cNow);
    setFlag(i, 1u);
    let ratio = min(1.0, spillV / max(1.0, vol + spillV));
    let solidLoss = getSsalt(i) * 0.05 * ratio;
    setDyn(2u, i, getSsalt(i) - solidLoss);
    addCtr(2u, i, solidLoss);
  }

  if (vol > 0.000000001) {
    let conc = salt / vol;
    // 仅结晶池析出固态盐;其它池过饱和也保持溶解态
    if (cellTypeOf(i) == 3u && conc > SAT_CONC) {
      let excess = salt - SAT_CONC * vol;
      let precip = excess * (1.0 - PRECIP_KEEP);
      salt = salt - precip;
      setDyn(2u, i, getSsalt(i) + precip);
    } else if (conc < SAT_CONC && getSsalt(i) > 0.0) {
      let deficit = SAT_CONC * vol - salt;
      let dissolve = min(deficit, getSsalt(i));
      salt = salt + dissolve;
      setDyn(2u, i, getSsalt(i) - dissolve);
    }
    if (netQ > getPrevDepth(i) * area * 0.05) { setDyn(5u, i, 0.0); }
    else { setDyn(5u, i, getBrineAge(i) + 1.0); }
    let beNow = concToBeW(salt / vol);
    var aged = false;
    if (cellTypeOf(i) == 3u && beNow >= SAT_BE - 0.5 && getBrineAge(i) >= 240.0) { aged = true; }
    if (beNow > BITTERN_BE || aged) { setFlag(i, 2u); }
  }

  setDyn(0u, i, max(0.0, vol / area));
  setDyn(1u, i, max(0.0, salt));
}
`;
}

/** Pass harvest:单 workgroup 串行收盐(预警抢收 + 常规调度) */
export function harvestShader(): string {
  return wgslTables() + wgslCommon() + /* wgsl */ `
@compute @workgroup_size(1)
fn main() {
  if (P.autoHarvest < 0.5) { return; }
  if (P.rain24 > 60.0) {
    for (var i = 0u; i < u32(P.nCells); i++) {
      if (cellTypeOf(i) == 3u && getSsalt(i) > 0.0) {
        let take = getSsalt(i);
        setDyn(2u, i, 0.0);
        addCtr(8u, i, take);
        setFlag(i, 4u);
        let cnt = harvestCnt();
        if (cnt < 1024u) {
          setHarvest(cnt, 0u, i);
          setHarvest(cnt, 1u, u32(P.hour));
          setHarvest(cnt, 2u, bitcast<u32>(take));
          setHarvestCnt(cnt + 1u);
        }
      }
    }
    return;
  }
  if (u32(P.hour) % 24u != 6u) { return; }
  var chosen = array<u32, 8>();
  var chosenN = 0u;
  let cap = min(u32(P.dailyCapacity), 8u);
  loop {
    if (chosenN >= cap) { break; }
    var best = 0xFFFFFFFFu;
    var bestMm = P.harvestSaltMm;
    for (var i = 0u; i < u32(P.nCells); i++) {
      if (cellTypeOf(i) != 3u) { continue; }
      var used = false;
      for (var k = 0u; k < chosenN; k++) { if (chosen[k] == i) { used = true; } }
      if (used) { continue; }
      let mm = (getSsalt(i) / SALT_BULK_DENSITY / cellArea(i)) * 1000.0;
      if (mm >= bestMm) { bestMm = mm; best = i; }
    }
    if (best == 0xFFFFFFFFu) { break; }
    chosen[chosenN] = best;
    chosenN = chosenN + 1u;
    let take = getSsalt(best);
    setDyn(2u, best, 0.0);
    addCtr(8u, best, take);
    setFlag(best, 4u);
    let cnt = harvestCnt();
    if (cnt < 1024u) {
      setHarvest(cnt, 0u, best);
      setHarvest(cnt, 1u, u32(P.hour));
      setHarvest(cnt, 2u, bitcast<u32>(take));
      setHarvestCnt(cnt + 1u);
    }
  }
}
`;
}
