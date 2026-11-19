// Ride helpers shared by the dashboard and its charts.
export const ZONES = [
  { n: 'Z1', name: 'Recovery',   lo: 0,    hi: 0.55 },
  { n: 'Z2', name: 'Endurance',  lo: 0.55, hi: 0.75 },
  { n: 'Z3', name: 'Tempo',      lo: 0.75, hi: 0.90 },
  { n: 'Z4', name: 'Threshold',  lo: 0.90, hi: 1.05 },
  { n: 'Z5', name: 'VO2max',     lo: 1.05, hi: 1.20 },
  { n: 'Z6', name: 'Anaerobic',  lo: 1.20, hi: 1.50 },
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: Infinity },
];

export const nz = v => v !== null && v !== undefined;
export const pad2 = n => String(n).padStart(2, '0');
export const fmtT = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
export const zoneOf = (p, ftp) => { const i = ZONES.findIndex(z => p / ftp < z.hi); return i < 0 ? 6 : i; };
export const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
