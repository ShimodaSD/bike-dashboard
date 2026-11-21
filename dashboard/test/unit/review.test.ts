// Ride review: ride type, load, heart-rate drift, pacing, workout targets and the FTP hint.
import { describe, expect, it } from 'vitest';
import { reviewRide, reviewWorkout } from '../../src/review/review';
import type { Workout } from '../../src/types/workout';
import { ride } from '../fixtures/ride';

const FTP = 200;
const steady = (w: number, sec: number) => Array<number>(sec).fill(w);
const note = (r: ReturnType<typeof reviewRide>, id: string) => r.notes.find(n => n.id === id);

describe('ride type and load', () => {
  it.each([
    [100, 'Recovery ride'], [130, 'Endurance ride'], [160, 'Tempo ride'],
    [180, 'Sweet spot ride'], [200, 'Threshold ride'], [230, 'Very hard ride'],
  ])('an hour at %i W (FTP 200) is a %s', (w, kind) => {
    expect(reviewRide({ hist: ride(steady(w, 3600)), ftp: FTP }).kind).toBe(kind);
  });

  it('an hour at FTP is 100 TSS, a moderate load', () => {
    const r = reviewRide({ hist: ride(steady(200, 3600)), ftp: FTP });
    expect(r.tss).toBeCloseTo(100, 0);
    expect(r.load).toBe('Moderate load');
    expect(note(r, 'load')?.text).toMatch(/recovered by tomorrow/);
  });

  it('three hours of sweet spot is a high load', () => {
    expect(reviewRide({ hist: ride(steady(180, 3 * 3600)), ftp: FTP }).load).toBe('High load');
  });

  it('names where most of the time went', () => {
    const r = reviewRide({ hist: ride(steady(130, 3600)), ftp: FTP });
    expect(note(r, 'intensity')?.text).toMatch(/Z2 Endurance \(100%\)/);
  });

  it('a ride under 5 minutes is too short to judge', () => {
    const r = reviewRide({ hist: ride(steady(200, 200)), ftp: FTP });
    expect(r.tooShort).toBe(true);
    expect(r.notes.map(n => n.id)).toEqual(['short']);
  });
});

describe('heart-rate drift (Pw:HR)', () => {
  // Steady 150 W for an hour, heart rate from `a` to `b` bpm in a straight line.
  const drift = (a: number, b: number) => ride(steady(150, 3600)).map((s, t) => ({ ...s, heart_rate_bpm: a + ((b - a) * t) / 3599 }));

  it('flat heart rate: held', () => {
    const r = reviewRide({ hist: drift(130, 130), ftp: FTP });
    expect(r.decoupling).toBeCloseTo(0, 5);
    expect(note(r, 'hr')?.tone).toBe('good');
  });

  it('heart rate up 20 bpm over the hour: some drift', () => {
    const r = reviewRide({ hist: drift(120, 140), ftp: FTP });
    expect(r.decoupling!).toBeGreaterThan(5);
    expect(r.decoupling!).toBeLessThan(10);
    expect(note(r, 'hr')?.title).toMatch(/Some heart-rate drift/);
  });

  it('big drift is flagged', () => {
    expect(note(reviewRide({ hist: drift(110, 160), ftp: FTP }), 'hr')?.tone).toBe('warn');
  });

  it('is not judged on a surgy ride', () => {
    const surgy = ride(Array.from({ length: 3600 }, (_, t) => (Math.floor(t / 60) % 2 ? 280 : 60)))
      .map(s => ({ ...s, heart_rate_bpm: 140 }));
    const r = reviewRide({ hist: surgy, ftp: FTP });
    expect(note(r, 'hr')?.title).toBe('Heart-rate drift not judged');
    expect(r.decoupling).toBeNull();
  });

  it('needs heart rate', () => {
    const r = reviewRide({ hist: ride(steady(150, 3600), { heart_rate_bpm: null }), ftp: FTP });
    expect(r.decoupling).toBeNull();
    expect(note(r, 'hr')).toBeUndefined();
  });
});

describe('pacing without heart rate', () => {
  it('a fade in the second half', () => {
    const r = reviewRide({ hist: ride([...steady(200, 1200), ...steady(150, 1200)], { heart_rate_bpm: null }), ftp: FTP });
    expect(note(r, 'pacing')?.title).toBe('Faded 25% in the second half');
  });
  it('a strong finish', () => {
    const r = reviewRide({ hist: ride([...steady(150, 1200), ...steady(180, 1200)], { heart_rate_bpm: null }), ftp: FTP });
    expect(note(r, 'pacing')?.title).toBe('Strong finish');
  });
});

describe('workout targets', () => {
  const wo: Workout = {
    name: '2 x 5 min', total: 1200,
    segs: [
      { dur: 300, lo: 0.5, hi: 0.5, unit: 'ftp', cad: null, name: 'Warm-up' },
      { dur: 300, lo: 1.0, hi: 1.0, unit: 'ftp', cad: null, name: 'Interval 1/2' },
      { dur: 300, lo: 1.0, hi: 1.0, unit: 'ftp', cad: null, name: 'Interval 2/2' },
      { dur: 300, lo: null, hi: null, unit: 'ftp', cad: null, name: 'Free ride' },
    ],
  };

  it('every step on target', () => {
    const w = reviewWorkout(ride([...steady(100, 300), ...steady(200, 600), ...steady(120, 300)]), wo, FTP)!;
    expect(w.onPct).toBe(100);
    expect(w).toMatchObject({ done: 3, total: 3, complete: true, missed: [] });
  });

  it('names the step that fell short', () => {
    const r = reviewRide({ hist: ride([...steady(100, 300), ...steady(200, 300), ...steady(160, 300), ...steady(120, 300)]), ftp: FTP, workout: wo });
    expect(r.workout!.missed.map(m => m.name)).toEqual(['Interval 2/2']);
    expect(note(r, 'workout')?.text).toMatch(/Interval 2\/2 \(160 W for 200 W\)/);
  });

  it('a ride that stopped early', () => {
    const w = reviewWorkout(ride([...steady(100, 300), ...steady(200, 200)]), wo, FTP)!;
    expect(w).toMatchObject({ done: 1, complete: false });
  });

  it('is skipped for an FTP test', () => {
    expect(reviewRide({ hist: ride(steady(200, 1200)), ftp: FTP, workout: wo, ftpTest: true }).workout).toBeNull();
  });
});

describe('FTP hint', () => {
  it('a best 20 min well above the FTP says the FTP may be higher', () => {
    const r = reviewRide({ hist: ride([...steady(150, 600), ...steady(240, 1200), ...steady(120, 600)]), ftp: FTP });
    expect(note(r, 'ftp')?.text).toMatch(/FTP near 228 W against 200 W/);
  });
  it('not when the FTP fits', () => {
    expect(note(reviewRide({ hist: ride(steady(200, 3600)), ftp: FTP }), 'ftp')).toBeUndefined();
  });
});
