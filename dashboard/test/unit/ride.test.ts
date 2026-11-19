// Ride maths the dashboard shows: zones, NP, TSS, IF, lap stats, best efforts, the live power number.
import { describe, expect, it } from 'vitest';
import { ZONES, avg3, bestPower, fmtT, fmtTss, livePower, stats, tssOf, zoneOf } from '../../src/util/ride';
import { ride, sample } from '../fixtures/ride';

describe('zones', () => {
  it.each([
    [0, 0], [109, 0], [110, 1], [149, 1], [150, 2], [179, 2], [180, 3], [209, 3],
    [210, 4], [239, 4], [240, 5], [299, 5], [300, 6], [2000, 6],
  ])('%i W at FTP 200 is Z%i+1', (p, z) => {
    expect(zoneOf(p, 200)).toBe(z);
  });

  it('covers 0 to infinity without gaps', () => {
    ZONES.slice(1).forEach((z, i) => expect(z.lo).toBe(ZONES[i].hi));
    expect(ZONES[0].lo).toBe(0);
    expect(ZONES[6].hi).toBe(Infinity);
  });
});

describe('stats', () => {
  it('is empty for no samples', () => {
    const s = stats([], 200, null);
    expect(s).toMatchObject({ n: 0, avgP: null, np: null, maxP: null, dist: 0, kj: 0 });
    expect(s.tiz).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('steady ride: NP equals average power', () => {
    const s = stats(ride(Array(600).fill(250)), 250, null);
    expect(s.avgP).toBe(250);
    expect(s.np).toBeCloseTo(250, 6);
    expect(s.maxP).toBe(250);
    expect(s.tiz[3]).toBe(600);                        // 100 % FTP = Z4
    expect(s.dist).toBeCloseTo(600 * 30 / 3.6, 6);
    expect(s.kj).toBeCloseTo(150, 6);
  });

  it('NP needs 30 s and uses the 30 s rolling average', () => {
    expect(stats(ride(Array(29).fill(200)), 200, null).np).toBeNull();
    const s = stats(ride([...Array(30).fill(100), ...Array(30).fill(300)]), 200, null);
    // rolling averages 100, 106.7 … 293.3, 300; NP is the 4th-power mean of those 31 values
    const rolls = Array.from({ length: 31 }, (_, k) => 100 + (200 * k) / 30);
    const np = Math.pow(rolls.reduce((t, r) => t + r ** 4, 0) / rolls.length, 0.25);
    expect(s.np).toBeCloseTo(np, 6);
  });

  it('intervals: NP above average power', () => {
    const s = stats(ride(Array.from({ length: 1200 }, (_, i) => (Math.floor(i / 60) % 2 ? 100 : 400))), 250, null);
    expect(s.avgP).toBe(250);
    expect(s.np!).toBeGreaterThan(280);
  });

  it('coasting counts toward time and NP, not toward averages', () => {
    const h = ride([...Array(40).fill(200), ...Array(20).fill(0)]);
    h.slice(40).forEach(x => { x.cadence_rpm = 0; });
    const s = stats(h, 200, null);
    expect(s.n).toBe(60);
    expect(s.moving).toBe(40);
    expect(s.avgP).toBe(200);
    expect(s.avgCad).toBe(90);
    expect(s.tiz.reduce((a, b) => a + b, 0)).toBe(40);
  });

  it('missing speed and heart rate stay empty', () => {
    const s = stats(ride([200, 200], { speed_kmh: null, heart_rate_bpm: null }), 200, null);
    expect(s.avgSpd).toBeNull();
    expect(s.avgHr).toBeNull();
    expect(s.maxHr).toBeNull();
  });

  it('lap stats: distance and energy from the sample before the lap', () => {
    const h = ride(Array(100).fill(200));
    const lap = stats(h.slice(60), 200, h[59]);
    expect(lap.n).toBe(40);
    expect(lap.dist).toBeCloseTo(40 * 30 / 3.6, 6);
    expect(lap.kj).toBeCloseTo(8, 6);
  });

  it('max heart rate', () => {
    const h = [sample(0, { heart_rate_bpm: 150 }), sample(1, { heart_rate_bpm: 171 }), sample(2, { heart_rate_bpm: 160 })];
    expect(stats(h, 200, null)).toMatchObject({ maxHr: 171, avgHr: (150 + 171 + 160) / 3 });
  });
});

describe('TSS and IF', () => {
  it('one hour at FTP is 100 TSS', () => {
    expect(tssOf(3600, 250, 250)).toBeCloseTo(100, 6);
  });

  it('half an hour at 90 % FTP', () => {
    expect(tssOf(1800, 180, 200)).toBeCloseTo(40.5, 6);     // 0.5 h x 0.9² x 100
  });

  it('no NP yet: no TSS', () => {
    expect(tssOf(20, null, 200)).toBeNull();
    expect(fmtTss(null)).toBe('–');
  });

  it('one decimal below 10, whole numbers above', () => {
    expect(fmtTss(4.26)).toBe('4.3');
    expect(fmtTss(57.6)).toBe(58);
  });
});

describe('best power', () => {
  it('finds the best stretch', () => {
    const h = ride([...Array(100).fill(150), ...Array(60).fill(320), ...Array(100).fill(150)]);
    expect(bestPower(h, 60)).toBe(320);
    expect(bestPower(h, 300)).toBeNull();                  // ride shorter than 5 min
  });
});

describe('live power number', () => {
  const now = { power_w: 300, cadence_rpm: 90, speed_kmh: 30, heart_rate_bpm: 150, at: 10_000 };
  const recent = [{ at: 6_000, p: 100 }, { at: 8_000, p: 200 }, { at: 9_000, p: 250 }, { at: 10_000, p: 300 }];

  it('instant shows the latest packet', () => {
    expect(livePower(now, recent, 0)).toBe(300);
  });

  it('3 s / 5 s average the packets in that window', () => {
    expect(livePower(now, recent, 3)).toBe(250);           // 200, 250, 300
    expect(livePower(now, recent, 5)).toBe(212.5);         // all four
  });

  it('falls back to the latest packet when the window is empty', () => {
    expect(livePower(now, [], 3)).toBe(300);
  });

  it('avg3 averages the last three seconds', () => {
    expect(avg3(ride([100, 200, 300, 400]))).toBe(300);
    expect(avg3([])).toBeNull();
  });
});

describe('time format', () => {
  it.each([[0, '0:00'], [59.4, '0:59'], [61, '1:01'], [3600, '1:00:00'], [3725, '1:02:05'], [-5, '0:00']])('%s s → %s', (s, txt) => {
    expect(fmtT(s)).toBe(txt);
  });
});
