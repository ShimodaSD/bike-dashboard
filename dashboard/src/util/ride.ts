// Ride helpers shared by the dashboard and its charts: zones, ride / lap stats, NP, TSS.
import type { LiveValues, Sample } from '../types/feed';
import type { LiveNow, RecentPower } from '../hooks/feed';

export interface Zone {
  n: string;                          // Z1 … Z7
  name: string;
  lo: number;                         // fraction of FTP
  hi: number;
}

export const ZONES: Zone[] = [
  { n: 'Z1', name: 'Recovery',   lo: 0,    hi: 0.55 },
  { n: 'Z2', name: 'Endurance',  lo: 0.55, hi: 0.75 },
  { n: 'Z3', name: 'Tempo',      lo: 0.75, hi: 0.90 },
  { n: 'Z4', name: 'Threshold',  lo: 0.90, hi: 1.05 },
  { n: 'Z5', name: 'VO2max',     lo: 1.05, hi: 1.20 },
  { n: 'Z6', name: 'Anaerobic',  lo: 1.20, hi: 1.50 },
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: Infinity },
];

export const nz = <T,>(v: T | null | undefined): v is T => v !== null && v !== undefined;
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const fmtT = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
export const zoneOf = (p: number, ftp: number) => { const i = ZONES.findIndex(z => p / ftp < z.hi); return i < 0 ? 6 : i; };
export const cssVar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Summary over a slice of 1 Hz samples. `before` = the sample just before the slice (for distance/kJ deltas).
export interface RideStats {
  n: number; moving: number; avgP: number | null; np: number | null; maxP: number | null;
  avgCad: number | null; avgSpd: number | null; avgHr: number | null; maxHr: number | null;
  dist: number; kj: number; tiz: number[];        // seconds in each power zone
}
export function stats(a: Sample[], ftp: number, before: Sample | null): RideStats {
  const out: RideStats = { n: a.length, moving: 0, avgP: null, np: null, maxP: null, avgCad: null, avgSpd: null,
                avgHr: null, maxHr: null, dist: 0, kj: 0, tiz: new Array(7).fill(0) };
  if (!a.length) return out;
  let sp = 0, mc = 0, sc = 0, cc = 0, ss = 0, sn = 0, sh = 0, hn = 0, mh = 0, mp = 0;
  let roll = 0, sum4 = 0, n4 = 0;
  a.forEach((s, i) => {
    const p = s.power_w || 0;
    const moving = p > 0 || (s.cadence_rpm || 0) > 0;
    if (moving) { out.moving++; sp += p; mc++; out.tiz[zoneOf(p, ftp)]++; }
    if (p > mp) mp = p;
    if (s.cadence_rpm > 0) { sc += s.cadence_rpm; cc++; }
    if (moving && nz(s.speed_kmh)) { ss += s.speed_kmh; sn++; }
    if (nz(s.heart_rate_bpm)) { sh += s.heart_rate_bpm; hn++; if (s.heart_rate_bpm > mh) mh = s.heart_rate_bpm; }
    roll += p; if (i >= 30) roll -= a[i - 30].power_w || 0;          // 30 s rolling average
    if (i >= 29) { sum4 += Math.pow(roll / 30, 4); n4++; }
  });
  out.avgP = mc ? sp / mc : null;
  out.maxP = mp;
  out.np = n4 ? Math.pow(sum4 / n4, 0.25) : null;
  out.avgCad = cc ? sc / cc : null;
  out.avgSpd = sn ? ss / sn : null;
  out.avgHr = hn ? sh / hn : null;
  out.maxHr = hn ? mh : null;
  const last = a[a.length - 1];
  out.dist = last.distance_m - (before ? before.distance_m : 0);
  out.kj = last.energy_kj - (before ? before.energy_kj : 0);
  return out;
}

// Best average power over any `sec`-second stretch of the ride (null if the ride is shorter).
export function bestPower(h: Sample[], sec: number) {
  if (h.length < sec) return null;
  let sum = 0, best = 0;
  h.forEach((s, i) => { sum += s.power_w || 0; if (i >= sec) sum -= h[i - sec].power_w || 0; if (i >= sec - 1 && sum > best) best = sum; });
  return best / sec;
}
export const tssOf = (n: number, np: number | null, ftp: number) => (np ? ((n * np * (np / ftp)) / (ftp * 3600)) * 100 : null);
export const fmtTss = (t: number | null) => (t === null ? '–' : t < 10 ? t.toFixed(1) : Math.round(t));

export const avg3 = (h: LiveValues[]) => { const w = h.slice(-3); return w.length ? w.reduce((t, s) => t + (s.power_w || 0), 0) / w.length : null; };

// Power shown live: the latest packet (instant) or the mean of the last `smooth` seconds of packets.
export function livePower(now: LiveNow, recent: RecentPower[], smooth: number) {
  if (!smooth) return now.power_w;
  const w = recent.filter(x => now.at - x.at < smooth * 1000);
  return w.length ? w.reduce((t, x) => t + x.p, 0) / w.length : now.power_w;
}

// Calories burned from the work done at the pedals: at ~24 % gross efficiency 1 kJ of work costs
// 1 / 0.24 ≈ 4.2 kJ of food energy ≈ 1 kcal, so the estimate most bike computers use is kcal = kJ.
export const kcalOf = (kj: number) => kj;
