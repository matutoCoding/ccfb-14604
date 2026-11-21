/**
 * 确定性合成气象/潮位数据:一整季 120 天 × 24 小时 = 2880 步。
 * 含第 32 天起连下三天的暴雨(对应"去年七月"那场)。
 */

export const SEASON_DAYS = 120;
export const HOURS = SEASON_DAYS * 24;

export interface WeatherHour {
  t: number; // 气温 °C
  rh: number; // 相对湿度 0~1
  wind: number; // 风速 m/s
  wdir: number; // 风向 rad
  rad: number; // 日照 W/m²
  rain: number; // 降雨量 mm/h
}

export interface WeatherDay {
  date: string; // ISO yyyy-mm-dd
  hours: WeatherHour[];
  rainMm: number;
  tMean: number;
}

/** mulberry32 确定性随机 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑噪声:每 6 小时一个控制点,线性插值 */
function smoothNoise(rand: () => number, n: number, step: number) {
  const controls: number[] = [];
  const count = Math.ceil(n / step) + 1;
  for (let i = 0; i < count; i++) controls.push(rand());
  return (i: number) => {
    const k = i / step;
    const i0 = Math.floor(k);
    const f = k - i0;
    return controls[i0] * (1 - f) + controls[Math.min(count - 1, i0 + 1)] * f;
  };
}

/** 暴雨窗口(小时,左闭右开):第 70 天 02:00 起 72 小时(七月中下旬特大暴雨) */
export const STORM_START = 70 * 24 + 2;
export const STORM_END = STORM_START + 72;

export interface SeasonData {
  startDate: string; // 季初日期(2025-05-01)
  weather: WeatherHour[];
  tides: Float64Array; // 逐时潮位 m
  /** 纳潮闸潮位阈值(高于此值可纳潮) */
  intakeLevel: number;
}

export function generateSeason(startDate = '2025-05-01', seed = 713): SeasonData {
  const rand = rng(seed);
  const nT = smoothNoise(rand, HOURS, 6);
  const nRH = smoothNoise(rand, HOURS, 6);
  const nW = smoothNoise(rand, HOURS, 12);
  const nDir = smoothNoise(rand, HOURS, 24);
  const rainRoll = smoothNoise(rand, HOURS, 3); // 独立的降雨概率序列
  const weather: WeatherHour[] = new Array(HOURS);

  for (let h = 0; h < HOURS; h++) {
    const day = h / 24;
    const hod = h % 24;
    // 季相:5~8 月升温,后期回落
    const season = Math.sin((day / SEASON_DAYS) * Math.PI);
    const tBase = 17 + 11 * season + (nT(h) - 0.5) * 4;
    const diurnal = hod >= 6 && hod <= 18 ? 4.5 * Math.sin(((hod - 6) / 12) * Math.PI) : -2;
    const t = tBase + diurnal;
    const rh = Math.max(0.35, Math.min(0.98, 0.78 - 0.25 * season + (nRH(h) - 0.5) * 0.22 - diurnal * 0.02));
    const wind = Math.max(0.5, 2.2 + (nW(h) - 0.5) * 3.5);
    const wdir = (nDir(h) - 0.5) * Math.PI * 0.8 + Math.PI * 0.25; // 以东南风为主
    const daylight = hod >= 6 && hod <= 19 ? Math.sin(((hod - 6) / 13) * Math.PI) : 0;
    const rad = daylight * 950 * (0.75 + nT(h) * 0.25);
    let rain = 0;
    // 零星小雨:约 4% 的白天时段有小雨,强度 0.5~3 mm/h
    if (rainRoll(h) > 0.96 && daylight > 0) rain = (rainRoll(h) - 0.96) * 75;
    // 三天特大暴雨:峰值约 6 mm/h,过程总量约 240 mm/3 日(足以漫顶化盐、对应"四十池化盐"量级)
    if (h >= STORM_START && h < STORM_END) {
      const ph = (h - STORM_START) / 72;
      const profile = Math.sin(ph * Math.PI);
      rain = 0.9 + 4.4 * profile + (rand() - 0.5) * 0.7;
    }
    weather[h] = {
      t: +t.toFixed(2),
      rh: +rh.toFixed(3),
      wind: +wind.toFixed(2),
      wdir: +wdir.toFixed(3),
      rad: +rad.toFixed(1),
      rain: +Math.max(0, rain).toFixed(2),
    };
  }

  // 半日潮:M2 主分潮 + 半月大潮小潮 + 浅水分潮
  const tides = new Float64Array(HOURS);
  const omega = (2 * Math.PI) / 12.42;
  for (let h = 0; h < HOURS; h++) {
    const spring = 0.9 + 0.7 * Math.cos((2 * Math.PI * h) / (14.77 * 24));
    const m2 = spring * Math.cos(omega * h + 0.6);
    const shallow = 0.25 * Math.cos(2 * omega * h + 1.1);
    tides[h] = +(2.6 + 1.4 * m2 + shallow).toFixed(3); // 潮位区间约 0.5~4.7 m
  }

  return { startDate, weather, tides, intakeLevel: 3.5 };
}

export function dayOfHour(h: number) {
  return Math.floor(h / 24);
}

export function aggregateDays(data: SeasonData): WeatherDay[] {
  const d0 = new Date(data.startDate + 'T00:00:00');
  const days: WeatherDay[] = [];
  for (let d = 0; d < SEASON_DAYS; d++) {
    const hours = data.weather.slice(d * 24, (d + 1) * 24);
    const date = new Date(d0.getTime() + d * 86400000).toISOString().slice(0, 10);
    days.push({
      date,
      hours,
      rainMm: +hours.reduce((s, x) => s + x.rain, 0).toFixed(1),
      tMean: +(hours.reduce((s, x) => s + x.t, 0) / 24).toFixed(1),
    });
  }
  return days;
}

/** 生成去年同季数据(同结构、不同种子),用于同池同比 */
export function generateLastSeason(): SeasonData {
  return generateSeason('2024-05-01', 1919);
}
