// Reference values for the ride maths, worked out by hand from the published definitions:
//   NP, IF, TSS        Coggan (Allen & Coggan, Training and Racing with a Power Meter)
//   VI                 NP ÷ average power over the same seconds
//   EF, Pw:HR          Friel / TrainingPeaks: EF = NP ÷ avg HR; decoupling = (EF1 − EF2) ÷ EF1, by halves
//   FTP from a test    95 % of the 20 min average (tests/test_ftp_test.py)
import { describe, expect, it } from 'vitest';
import { npOf, stats, tssOf } from '../../src/util/ride';
import { reviewRide } from '../../src/review/review';
import { parseFit } from '../../src/import/ridefile';
import { ride } from '../fixtures/ride';

const steady = (w: number, s: number) => Array<number>(s).fill(w);

describe('NP, IF and TSS', () => {
  it('npOf: steady power is its own NP; under 30 s there is none', () => {
    expect(npOf(steady(237, 600))).toBeCloseTo(237, 9);
    expect(npOf(steady(237, 29))).toBeNull();
  });

  it('npOf agrees with the ride stats', () => {
    const pw = Array.from({ length: 1800 }, (_, i) => (Math.floor(i / 45) % 3 === 0 ? 380 : 160));
    expect(npOf(pw)).toBeCloseTo(stats(ride(pw), 250, null).np!, 9);
  });

  it('TSS = hours × IF² × 100', () => {
    expect(tssOf(7200, 187.5, 250)).toBeCloseTo(112.5, 9);          // 2 h at IF 0.75
    expect(tssOf(2700, 275, 250)).toBeCloseTo(90.75, 9);            // 45 min at IF 1.10
  });

  it('IF = NP ÷ FTP', () => {
    expect(reviewRide({ hist: ride(steady(180, 3600)), ftp: 240 }).IF).toBeCloseTo(0.75, 9);
  });
});

describe('variability index', () => {
  it('uses the average of every second, like NP does', () => {
    // 20 min at 250 W, then 10 min stopped (0 W, 0 rpm): NP counts the stop as 0 W, so must the average
    const h = ride([...steady(250, 1200), ...steady(0, 600)]);
    h.slice(1200).forEach(s => { s.cadence_rpm = 0; });
    const np = npOf(h.map(s => s.power_w))!;
    const r = reviewRide({ hist: h, ftp: 250 });
    expect(r.VI).toBeCloseTo(np / (250 * 1200 / 1800), 9);
    expect(r.VI!).toBeGreaterThan(1);           // the moving-only average (250 W) gave < 1, impossible for VI
  });
});

describe('heart-rate drift uses efficiency factor (NP ÷ HR) per half', () => {
  it('same average power, surgier second half: NP is higher, so EF is too', () => {
    // 65 min, HR 140 throughout. 0–35 min steady 200 W; then 30 s at 170 / 30 s at 230 (avg 200 W)
    const pw = [...steady(200, 2100), ...Array.from({ length: 1800 }, (_, i) => (Math.floor(i / 30) % 2 ? 230 : 170))];
    const r = reviewRide({ hist: ride(pw), ftp: 250 });
    // the first 5 min are left out, then the hour is split in two halves of 30 min
    const ef1 = npOf(pw.slice(300, 2100))! / 140, ef2 = npOf(pw.slice(2100))! / 140;
    expect(r.decoupling).toBeCloseTo(((ef1 - ef2) / ef1) * 100, 9);
    expect(r.decoupling!).toBeLessThan(0);      // average power per half would have said 0 %
  });

  it('EF = NP ÷ average heart rate', () => {
    const h = ride(steady(200, 3600)).map(s => ({ ...s, heart_rate_bpm: 125 }));
    expect(reviewRide({ hist: h, ftp: 250 }).ef).toBeCloseTo(1.6, 9);
  });
});

describe('.fit compressed timestamps', () => {
  // A timestamped event message, then records with compressed headers: their time counts from
  // the event's timestamp (FIT protocol: the last timestamp field of any message).
  function fit(): ArrayBuffer {
    const b: number[] = [];
    const u8 = (x: number) => b.push(x & 0xff);
    const u32 = (x: number) => { u8(x); u8(x >>> 8); u8(x >>> 16); u8(x >>> 24); };
    const u16 = (x: number) => { u8(x); u8(x >>> 8); };
    const ts = 1100000000;
    // record (20) with its own timestamp, local 0
    u8(0x40); u8(0); u8(0); u16(20); u8(2); u8(253); u8(4); u8(0x86); u8(7); u8(2); u8(0x84);
    u8(0x00); u32(ts); u16(200);
    // event (21), local 1, timestamp only: 100 s later
    u8(0x41); u8(0); u8(0); u16(21); u8(1); u8(253); u8(4); u8(0x86);
    u8(0x01); u32(ts + 100);
    // record without timestamp field, local 2, sent with a compressed header 1 s after the event
    u8(0x42); u8(0); u8(0); u16(20); u8(1); u8(7); u8(2); u8(0x84);
    u8(0x80 | (2 << 5) | ((ts + 101) & 0x1f)); u16(210);
    const data = Uint8Array.from(b), out = new Uint8Array(14 + data.length + 2), v = new DataView(out.buffer);
    v.setUint8(0, 14); v.setUint8(1, 0x20); v.setUint16(2, 2132, true); v.setUint32(4, data.length, true);
    out.set([0x2e, 0x46, 0x49, 0x54], 8); out.set(data, 14);
    return out.buffer;
  }

  it('count from the last timestamp of any message', () => {
    const pts = parseFit(fit());
    expect(pts.map(p => p.t - pts[0].t)).toEqual([0, 101]);
    expect(pts.map(p => p.power)).toEqual([200, 210]);
  });
});
