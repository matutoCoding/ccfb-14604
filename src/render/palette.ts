/**
 * 渲染调色板:卤水随波美度青灰→浅红;盐层湿亮→干白;漫顶红、苦卤紫、已收标记。
 */
import { BITTERN_BE, SAT_BE } from '../sim/units';

function mix(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const g2 = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${g2})`;
}

// 卤水色:低浓青灰 → 中浓灰绿 → 高浓浅红 → 苦卤暗紫红
const BRINE_STOPS: [number, number[]][] = [
  [0, [74, 92, 102]], // 青灰
  [8, [86, 108, 104]],
  [16, [122, 128, 104]],
  [22, [168, 142, 112]],
  [SAT_BE, [196, 128, 104]], // 饱和浅红
  [BITTERN_BE, [158, 84, 96]], // 苦卤
  [34, [112, 58, 84]],
];

export function brineColor(be: number, depth: number): string {
  const t = clamp((be - BRINE_STOPS[0][0]) / (BITTERN_BE - BRINE_STOPS[0][0]), 0, 1);
  let c = BRINE_STOPS[0][1];
  for (let i = 0; i < BRINE_STOPS.length - 1; i++) {
    if (be >= BRINE_STOPS[i][0] && be <= BRINE_STOPS[i + 1][0]) {
      const lt = (be - BRINE_STOPS[i][0]) / (BRINE_STOPS[i + 1][0] - BRINE_STOPS[i][0]);
      c = lerp3(BRINE_STOPS[i][1], BRINE_STOPS[i + 1][1], lt);
      break;
    }
  }
  // 水越浅越暗(露底质感)
  const depthFactor = clamp(0.55 + depth * 0.9, 0.55, 1.1);
  return `rgb(${clamp255(c[0] * depthFactor)},${clamp255(c[1] * depthFactor)},${clamp255(c[2] * depthFactor)})`;
}

/** 盐层色:薄而湿→厚而干白;saltMm 厚度, wetness 0(干)~1(湿) */
export function saltColor(saltMm: number, wetness: number): string {
  const thickness = clamp(saltMm / 120, 0, 1);
  const wet = [206, 202, 188]; // 湿亮微黄
  const dry = [245, 246, 248]; // 干白
  const c = lerp3(wet, dry, thickness * (1 - wetness * 0.6));
  const sparkle = wetness > 0.4 ? 18 * wetness : 0;
  return `rgb(${clamp255(c[0] + sparkle)},${clamp255(c[1] + sparkle)},${clamp255(c[2] + sparkle)})`;
}

export const FLAG_COLORS = {
  overtop: 'rgba(220,48,48,0.55)',
  bittern: 'rgba(150,70,180,0.5)',
  harvested: 'rgba(40,120,220,0.35)',
  gateOpen: '#3aa655',
  gateClosed: '#b04438',
  ridge: '#6b5b46',
  channel: '#3d5a6c',
};

export function stageColor(type: number): string {
  switch (type) {
    case 0:
      return '#2f6f8f'; // 纳潮库
    case 1:
      return '#4a7d5a'; // 蒸发
    case 2:
      return '#8a7a3a'; // 调节
    case 3:
      return '#9a5a44'; // 结晶
    default:
      return '#666';
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function clamp255(v: number) {
  return Math.round(clamp(v, 0, 255));
}
function lerp3(a: number[], b: number[], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
void mix;
