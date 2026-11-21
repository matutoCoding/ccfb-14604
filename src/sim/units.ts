/**
 * 物理化学常量与波美度(°Bé)换算。
 * 所有公式以显式查找表实现,同一份表会注入 WGSL 着色器,保证 CPU/GPU 结果一致。
 * 单位:体积 m³,盐量 kg(溶解盐与固态盐分别记账),深度 m,浓度 kg/m³。
 */

/** 波美度 → 密度(kg/m³),重表公式 d = 145/(145-Bé) */
export function beToDensity(be: number): number {
  return 145 / (145 - be) * 1000;
}

/**
 * 海水蒸发过程中 波美度 → 总溶解盐质量分数 的实测型查表 (NaCl/Mg 盐合计)。
 * 25°Bé 为 NaCl 饱和点;30°Bé 以上为苦卤区。
 */
export const BE_POINTS = [0, 3, 5, 8, 10, 12, 15, 17, 20, 22, 24, 25, 26, 28, 30, 32] as const;
export const W_POINTS = [
  0.0, 0.0355, 0.054, 0.078, 0.096, 0.117, 0.149, 0.172, 0.209, 0.234, 0.261,
  0.265, 0.272, 0.288, 0.303, 0.315,
] as const;

/** 浓度 kg/m³ 查找表 c(Bé)=w·d */
export const CONC_TABLE: number[] = BE_POINTS.map((be, i) => {
  const d = beToDensity(be) / 1000;
  return W_POINTS[i] * d * 1000;
});

function interp(x: number, xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** 波美度 → 溶解盐浓度 kg/m³ */
export function beToConc(be: number): number {
  return interp(be, BE_POINTS, CONC_TABLE);
}

/** 溶解盐浓度 → 波美度(反查,表单调) */
export function concToBe(c: number): number {
  return interp(c, CONC_TABLE, BE_POINTS);
}

export const SAT_BE = 25; // NaCl 饱和波美度
export const SAT_CONC = beToConc(SAT_BE); // ≈ 320 kg/m³
export const BITTERN_BE = 30; // 苦卤排放阈值
export const PRECIP_KEEP = 0.15; // 超过饱和浓度后,溶解态保留 15%,其余 85% 析为固态盐
export const SEA_BE = 3.2; // 纳潮海水波美度
export const SEA_CONC = beToConc(SEA_BE); // ≈ 41 kg/m³

export const SALT_BULK_DENSITY = 1200; // 盐板堆积密度 kg/m³
export const WEIR_COEF = 1.7; // 堰流流量系数(含 sqrt(2g) 项),m^0.5/s
export const DT_HOURS = 1; // 仿真步长 1 小时
export const SECONDS_PER_HOUR = 3600;

/** 蒸发经验系数(标定到渤海盐田:盛夏晴日约 7~9 mm/日) */
export const EVAP_COEF = 0.2;
export const EVAP_MAX_MM_H = 1.0;

/**
 * 单格蒸发量 (m³/h),气象量为小时均值:
 * T 气温°C,RH 相对湿度 0~1,u 风速 m/s,rad 日照 W/m²
 * 晴日正午典型输出 ≈ 0.7~0.8 mm/h(日累计 6~8 mm)
 */
export function evapMmH(T: number, RH: number, u: number, rad: number): number {
  const e =
    EVAP_COEF *
    (0.6 + 0.04 * T) *
    Math.max(0.05, 1 - RH) *
    (0.5 + 0.12 * u) *
    (0.35 + rad / 900);
  return Math.max(0, Math.min(EVAP_MAX_MM_H, e));
}

/** 生成注入 WGSL 的查找表常量段 */
export function wgslTables(): string {
  const conc = CONC_TABLE.map((v) => v.toFixed(4)).join(', ');
  const be = [...BE_POINTS].join(', ');
  return /* wgsl */ `
const BE_POINTS: array<f32, ${BE_POINTS.length}> = array<f32, ${BE_POINTS.length}>(${be});
const CONC_TABLE: array<f32, ${CONC_TABLE.length}> = array<f32, ${CONC_TABLE.length}>(${conc});
const SAT_CONC: f32 = ${SAT_CONC.toFixed(4)};
const SAT_BE: f32 = ${SAT_BE.toFixed(4)};
const BITTERN_BE: f32 = ${BITTERN_BE.toFixed(4)};
const PRECIP_KEEP: f32 = ${PRECIP_KEEP.toFixed(4)};
const SEA_CONC: f32 = ${SEA_CONC.toFixed(4)};
const SALT_BULK_DENSITY: f32 = ${SALT_BULK_DENSITY.toFixed(4)};
const WEIR_COEF: f32 = ${WEIR_COEF.toFixed(4)};
const DT: f32 = ${DT_HOURS.toFixed(4)};
const SECS_PER_HOUR: f32 = ${SECONDS_PER_HOUR.toFixed(4)};

// 直接索引 module-scope const 数组,避免在函数内构造 runtime-sized array
fn beToConcW(be: f32) -> f32 {
  if (be <= BE_POINTS[0]) { return CONC_TABLE[0]; }
  if (be >= BE_POINTS[${BE_POINTS.length - 1}u]) { return CONC_TABLE[${BE_POINTS.length - 1}u]; }
  for (var i = 0u; i < ${BE_POINTS.length - 1}u; i++) {
    if (BE_POINTS[i + 1u] >= be) {
      let t = (be - BE_POINTS[i]) / (BE_POINTS[i + 1u] - BE_POINTS[i]);
      return CONC_TABLE[i] + t * (CONC_TABLE[i + 1u] - CONC_TABLE[i]);
    }
  }
  return CONC_TABLE[${BE_POINTS.length - 1}u];
}

fn concToBeW(c: f32) -> f32 {
  if (c <= CONC_TABLE[0]) { return BE_POINTS[0]; }
  if (c >= CONC_TABLE[${BE_POINTS.length - 1}u]) { return BE_POINTS[${BE_POINTS.length - 1}u]; }
  for (var i = 0u; i < ${BE_POINTS.length - 1}u; i++) {
    if (CONC_TABLE[i + 1u] >= c) {
      let t = (c - CONC_TABLE[i]) / (CONC_TABLE[i + 1u] - CONC_TABLE[i]);
      return BE_POINTS[i] + t * (BE_POINTS[i + 1u] - BE_POINTS[i]);
    }
  }
  return BE_POINTS[${BE_POINTS.length - 1}u];
}
`;
}
