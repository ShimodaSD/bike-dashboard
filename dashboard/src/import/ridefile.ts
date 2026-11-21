// Read a ride someone already did from a file, in the browser, so the Ride review can evaluate it:
//   .fit   this logger, Garmin, Wahoo, Zwift, Strava's "Export original"
//   .tcx   Garmin Connect / Strava exports (power in the TPX extension)
//   .gpx   exports with heart rate / cadence / power extensions (no power: no review of power)
//   .csv   the logger's session_1hz.csv, or the dashboard's Export CSV
// Every format comes out as the same 1 Hz samples the live feed sends, so the review and the
// ride maths run unchanged. Nothing is uploaded: the file is read here.
import type { Sample } from '../types/feed';

export interface RideFile {
  name: string;
  start: Date | null;
  hist: Sample[];
  hasPower: boolean;
  hasHr: boolean;
}

// One reading at a moment in time, as found in the file (any field may be missing).
interface Point {
  t: number;                          // s since 1970 (UTC)
  power?: number | null;
  hr?: number | null;
  cad?: number | null;
  speed?: number | null;              // km/h
  dist?: number | null;               // m, cumulative
}

const MAX_GAP_S = 10;                 // a longer gap is a pause: left out, not filled in

// FileReader rather than File.text() / arrayBuffer(): works in every browser the dashboard runs in.
function load(file: File, as: 'text'): Promise<string>;
function load(file: File, as: 'buffer'): Promise<ArrayBuffer>;
function load(file: File, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string | ArrayBuffer);
    r.onerror = () => fail(new Error('This file could not be read.'));
    if (as === 'text') r.readAsText(file); else r.readAsArrayBuffer(file);
  });
}

export async function readRideFile(file: File): Promise<RideFile> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let pts: Point[];
  if (ext === 'fit') pts = parseFit(await load(file, 'buffer'));
  else if (ext === 'tcx') pts = parseTcx(await load(file, 'text'));
  else if (ext === 'gpx') pts = parseGpx(await load(file, 'text'));
  else if (ext === 'csv') pts = parseCsv(await load(file, 'text'));
  else throw new Error('Choose a .fit, .tcx, .gpx or .csv file.');
  return toRide(file.name, pts);
}

// ------------------------------------------------------------------ 1 Hz timeline
// Readings are put on whole seconds; short gaps (1 s recording, dropouts) hold the last reading,
// long gaps are pauses and are skipped. Distance and energy add up like the logger's.
export function toRide(name: string, raw: Point[]): RideFile {
  const pts = raw.filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (!pts.length) throw new Error('No ride data found in this file.');
  const hist: Sample[] = [];
  let dist = 0, kj = 0, lastDist: number | null = null, prev: Point | null = null, prevSec = -Infinity;
  const push = (p: Point, sec: number, fill = false) => {
    const speed = p.speed ?? null;
    if (fill) { if (lastDist == null && speed != null) dist += speed / 3.6; }   // the next reading's distance covers it
    else if (p.dist != null) { if (lastDist != null && p.dist >= lastDist) dist += p.dist - lastDist; lastDist = p.dist; }
    else if (speed != null) dist += speed / 3.6;
    const power = Math.max(0, Math.round(p.power ?? 0));
    kj += power / 1000;
    hist.push({
      t: hist.length, timestamp_utc: new Date(sec * 1000).toISOString(), lap: 1,
      power_w: power, cadence_rpm: Math.round(p.cad ?? 0),
      speed_kmh: speed == null ? null : Math.round(speed * 10) / 10,
      heart_rate_bpm: p.hr ? Math.round(p.hr) : null,
      distance_m: dist, energy_kj: kj, grade_pct: null,
    });
  };
  for (const p of pts) {
    const sec = Math.floor(p.t);
    if (sec <= prevSec) continue;                       // several readings in one second: keep the first
    if (prev && sec - prevSec <= MAX_GAP_S)
      for (let s = prevSec + 1; s < sec; s++) push(prev, s, true);
    push(p, sec);
    prev = p; prevSec = sec;
  }
  return {
    name, start: new Date(Math.floor(pts[0].t) * 1000), hist,
    hasPower: pts.some(p => (p.power ?? 0) > 0),
    hasHr: pts.some(p => (p.hr ?? 0) > 0),
  };
}

// ------------------------------------------------------------------ .fit
// The record message (global 20): timestamp 253, heart_rate 3, cadence 4, distance 5 (cm),
// speed 6 (mm/s), power 7, enhanced_speed 73 (mm/s). Other messages are skipped.
const FIT_EPOCH = 631065600;          // 1989-12-31T00:00:00Z in Unix seconds

interface FitField { num: number; size: number; base: number }
interface FitDef { little: boolean; global: number; fields: FitField[]; devSize: number }

export function parseFit(buf: ArrayBuffer): Point[] {
  const v = new DataView(buf);
  if (buf.byteLength < 12) throw new Error('This .fit file is empty or cut short.');
  const hsize = v.getUint8(0);
  const sig = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11));
  if (sig !== '.FIT') throw new Error('This is not a .fit file.');
  const end = Math.min(buf.byteLength, hsize + v.getUint32(4, true));
  const defs = new Map<number, FitDef>();
  const out: Point[] = [];
  let pos = hsize, lastTs = 0;

  const read = (at: number, size: number, base: number, little: boolean): number | null => {
    const t = base & 0x1f;              // base type number
    let x: number, bad: number;
    if (t === 0 || t === 2 || t === 10 || t === 13) { x = v.getUint8(at); bad = t === 10 ? 0 : 0xff; }
    else if (t === 1) { x = v.getInt8(at); bad = 0x7f; }
    else if (t === 4 || t === 11) { if (size < 2) return null; x = v.getUint16(at, little); bad = t === 11 ? 0 : 0xffff; }
    else if (t === 3) { if (size < 2) return null; x = v.getInt16(at, little); bad = 0x7fff; }
    else if (t === 6 || t === 12) { if (size < 4) return null; x = v.getUint32(at, little); bad = t === 12 ? 0 : 0xffffffff; }
    else if (t === 5) { if (size < 4) return null; x = v.getInt32(at, little); bad = 0x7fffffff; }
    else return null;
    return x === bad ? null : x;
  };

  while (pos < end) {
    const h = v.getUint8(pos++);
    if (h & 0x80) {                                     // compressed timestamp header
      const local = (h >> 5) & 0x03, off = h & 0x1f;
      const def = defs.get(local);
      if (!def) throw new Error('This .fit file is damaged.');
      lastTs = ((lastTs & ~0x1f) >>> 0) + off + (off < (lastTs & 0x1f) ? 0x20 : 0);
      pos = dataMsg(def, pos, lastTs);
    } else if (h & 0x40) {                              // definition message
      const local = h & 0x0f, dev = (h & 0x20) !== 0;
      const little = v.getUint8(pos + 1) === 0;
      const global = v.getUint16(pos + 2, little);
      const n = v.getUint8(pos + 4);
      pos += 5;
      const fields: FitField[] = [];
      for (let i = 0; i < n; i++, pos += 3) fields.push({ num: v.getUint8(pos), size: v.getUint8(pos + 1), base: v.getUint8(pos + 2) });
      let devSize = 0;
      if (dev) { const nd = v.getUint8(pos++); for (let i = 0; i < nd; i++, pos += 3) devSize += v.getUint8(pos + 1); }
      defs.set(local, { little, global, fields, devSize });
    } else {
      const def = defs.get(h & 0x0f);
      if (!def) throw new Error('This .fit file is damaged.');
      pos = dataMsg(def, pos, null);
    }
  }
  return out;

  function dataMsg(def: FitDef, at: number, ts: number | null): number {
    if (def.global !== 20) return at + def.fields.reduce((t, f) => t + f.size, 0) + def.devSize;
    const f: Record<number, number | null> = {};
    for (const fd of def.fields) { f[fd.num] = read(at, fd.size, fd.base, def.little); at += fd.size; }
    at += def.devSize;
    const stamp = f[253] ?? ts;
    if (f[253] != null) lastTs = f[253]!;
    if (stamp == null) return at;
    const mms = f[73] ?? f[6];
    out.push({ t: stamp + FIT_EPOCH, power: f[7], hr: f[3], cad: f[4],
               speed: mms == null ? null : (mms / 1000) * 3.6, dist: f[5] == null ? null : f[5]! / 100 });
    return at;
  }
}

// ------------------------------------------------------------------ .tcx / .gpx
// Matched by local name, so any namespace prefix (ns3:Watts, gpxtpx:hr, ...) works.
const kids = (el: Element, name: string) => Array.from(el.getElementsByTagName('*')).filter(e => e.localName === name);
const numIn = (el: Element, ...names: string[]) => {
  for (const n of names) { const e = kids(el, n)[0]; const x = e ? parseFloat(e.textContent || '') : NaN; if (Number.isFinite(x)) return x; }
  return null;
};
function xml(text: string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This file could not be read (broken XML).');
  return doc;
}

export function parseTcx(text: string): Point[] {
  return kids(xml(text).documentElement, 'Trackpoint').flatMap(tp => {
    const time = kids(tp, 'Time')[0]?.textContent;
    const t = time ? Date.parse(time) / 1000 : NaN;
    if (!Number.isFinite(t)) return [];
    const hrEl = kids(tp, 'HeartRateBpm')[0];
    const mps = numIn(tp, 'Speed');
    return [{ t, power: numIn(tp, 'Watts'), hr: hrEl ? numIn(hrEl, 'Value') : null, cad: numIn(tp, 'Cadence', 'RunCadence'),
              speed: mps == null ? null : mps * 3.6, dist: numIn(tp, 'DistanceMeters') }];
  });
}

export function parseGpx(text: string): Point[] {
  return kids(xml(text).documentElement, 'trkpt').flatMap(tp => {
    const time = kids(tp, 'time')[0]?.textContent;
    const t = time ? Date.parse(time) / 1000 : NaN;
    if (!Number.isFinite(t)) return [];
    return [{ t, power: numIn(tp, 'power', 'PowerInWatts'), hr: numIn(tp, 'hr', 'heartrate'), cad: numIn(tp, 'cad', 'cadence') }];
  });
}

// ------------------------------------------------------------------ .csv (this logger)
export function parseCsv(text: string): Point[] {
  const lines = text.trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map(s => s.trim());
  const col = (n: string) => head.indexOf(n);
  const ti = col('timestamp_utc');
  if (ti < 0 || col('power_w') < 0) throw new Error('This CSV is not a ride from this logger (no timestamp_utc / power_w columns).');
  const num = (cells: string[], n: string) => { const i = col(n); if (i < 0) return null; const x = parseFloat(cells[i]); return Number.isFinite(x) ? x : null; };
  return lines.flatMap(l => {
    const c = l.split(',');
    const iso = c[ti]?.trim();
    const t = iso ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z') / 1000 : NaN;
    if (!Number.isFinite(t)) return [];
    return [{ t, power: num(c, 'power_w'), hr: num(c, 'heart_rate_bpm'), cad: num(c, 'cadence_rpm'),
              speed: num(c, 'speed_kmh'), dist: num(c, 'distance_m') }];
  });
}
