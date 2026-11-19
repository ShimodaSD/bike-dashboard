// Ride helpers shared by the dashboard and its charts.
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
