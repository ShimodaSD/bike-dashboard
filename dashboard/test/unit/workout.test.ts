// Workout files (.zwo / .erg / .mrc), where the ride is in them, the targets and the off-target rules.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAD_TOL, beepDue, offTarget, parseWorkout, plannedLine, powerTol, tileTargets, workoutAt, type BeepClock } from '../../src/workout/workout';
import type { Workout } from '../../src/types/workout';

const repoWorkout = (name: string) => parseWorkout(readFileSync(join(import.meta.dirname, '../../../workouts', name), 'utf8'), name);
const zwo = (body: string, name = '') => `<workout_file>${name ? `<name>${name}</name>` : ''}<workout>${body}</workout></workout_file>`;

describe('parsing .zwo', () => {
  it('reads every workout in workouts/', () => {
    for (const f of ['power-sweet-spot.zwo', 'heart-rate-zones.zwo', 'cadence-drills.zwo', 'speed-steps.zwo', 'climb-repeats.zwo']) {
      const wo = repoWorkout(f);
      expect(wo.segs.length, f).toBeGreaterThan(2);
      expect(wo.total, f).toBe(wo.segs.reduce((t, s) => t + s.dur, 0));
    }
  });

  it('sweet spot: warm-up ramp, 3 x (on + recovery), cool-down', () => {
    const wo = repoWorkout('power-sweet-spot.zwo');
    expect(wo.name).toBe('Power test · Sweet spot 3x3');
    expect(wo.total).toBe(18 * 60);
    expect(wo.segs.map(s => s.name)).toEqual(['Warm-up', 'Interval 1/3', 'Recovery', 'Interval 2/3', 'Recovery',
      'Interval 3/3', 'Recovery', 'Cool-down']);
    expect(wo.segs[0]).toMatchObject({ dur: 240, lo: 0.5, hi: 0.75, unit: 'ftp' });
    expect(wo.segs[1]).toMatchObject({ dur: 180, lo: 0.9, hi: 0.9 });
  });

  it('climb repeats: grades on free rides and intervals, cadence on and off', () => {
    const wo = repoWorkout('climb-repeats.zwo');
    expect(wo.segs[0]).toMatchObject({ name: 'Free ride', lo: null, grade: 0 });
    expect(wo.segs[2]).toMatchObject({ dur: 180, grade: 6, cad: 80 });
    expect(wo.segs[3]).toMatchObject({ dur: 120, grade: 0, cad: 90, name: 'Recovery' });
  });

  it('heart-rate and speed extras', () => {
    const wo = parseWorkout(zwo('<SteadyState Duration="60" HeartRate="140" Speed="30"/>' +
      '<IntervalsT Repeat="2" OnDuration="30" OffDuration="30" OnHeartRate="160" OffHeartRate="120" OnSpeed="35" OffSpeed="25"/>'), 'x.zwo');
    expect(wo.segs[0]).toMatchObject({ hr: 140, spd: 30, lo: null });
    expect(wo.segs[1]).toMatchObject({ hr: 160, spd: 35 });
    expect(wo.segs[2]).toMatchObject({ hr: 120, spd: 25 });
  });

  it('Zwift power attribute variants', () => {
    const wo = parseWorkout(zwo('<SteadyState Duration="60" Power="0.8"/><Ramp Duration="60" PowerLow="0.5" PowerHigh="1"/>' +
      '<IntervalsT Repeat="1" OnDuration="10" OffDuration="10" PowerOnHigh="1.2" PowerOffLow="0.4"/><MaxEffort Duration="15"/>'), 'x.zwo');
    expect(wo.segs.map(s => [s.name, s.lo, s.hi])).toEqual([
      ['Steady', 0.8, 0.8], ['Ramp', 0.5, 1], ['Interval 1/1', 1.2, 1.2], ['Recovery', 0.4, 0.4], ['Max effort', null, null]]);
  });

  it('skips text events and zero-length steps; name falls back to the file name', () => {
    const wo = parseWorkout(zwo('<textevent timeoffset="0" message="hi"/><SteadyState Duration="0" Power="1"/><SteadyState Duration="30" Power="1"/>'), 'My Ride.zwo');
    expect(wo.segs).toHaveLength(1);
    expect(wo.name).toBe('My Ride');
  });

  it('explains files it cannot read', () => {
    expect(() => parseWorkout('<workout_file/>', 'a.zwo')).toThrow('no <workout> section');
    expect(() => parseWorkout(zwo(''), 'a.zwo')).toThrow('No workout steps');
    expect(() => parseWorkout('hello', 'a.erg')).toThrow('No [COURSE DATA]');
  });
});

describe('parsing .erg / .mrc', () => {
  const course = (rows: string) => `[COURSE HEADER]\nUNITS = ENGLISH\n[END COURSE HEADER]\n[COURSE DATA]\n${rows}\n[END COURSE DATA]\n`;

  it('.erg in watts: points joined into steady steps and ramps', () => {
    const wo = parseWorkout(course('0 100\n5 100\n5 250\n10 250\n15 150'), 'test.erg');
    expect(wo.segs).toEqual([
      { dur: 300, lo: 100, hi: 100, unit: 'w', cad: null, name: 'Steady' },
      { dur: 300, lo: 250, hi: 250, unit: 'w', cad: null, name: 'Steady' },
      { dur: 300, lo: 250, hi: 150, unit: 'w', cad: null, name: 'Ramp' },
    ]);
    expect(wo.name).toBe('test');
  });

  it('.mrc in % FTP, Windows line endings', () => {
    const wo = parseWorkout(course('0\t50\r\n10\t50\r\n10\t90\r\n20\t90').replace(/\n/g, '\r\n'), 'b.mrc');
    expect(wo.segs.map(s => [s.dur, s.lo, s.unit])).toEqual([[600, 0.5, 'ftp'], [600, 0.9, 'ftp']]);
  });
});

describe('where the ride is', () => {
  const wo = repoWorkout('power-sweet-spot.zwo');

  it('ramps the target through the warm-up', () => {
    expect(workoutAt(wo, 0, 200)).toMatchObject({ i: 0, into: 0, left: 240, target: 100 });
    expect(workoutAt(wo, 120, 200)!.target).toBeCloseTo(125);
  });

  it('moves to the next step on the second it starts', () => {
    const at = workoutAt(wo, 240, 200)!;
    expect(at).toMatchObject({ i: 1, into: 0, target: 180 });
    expect(at.next!.name).toBe('Recovery');
  });

  it('is done after the last step', () => {
    expect(workoutAt(wo, wo.total - 1, 200)!.next).toBeUndefined();
    expect(workoutAt(wo, wo.total, 200)).toBeNull();
  });

  it('.erg targets ignore FTP', () => {
    const erg = parseWorkout('[COURSE DATA]\n0 150\n1 150', 'a.erg');
    expect(workoutAt(erg, 10, 300)!.target).toBe(150);
  });

  it('plans the chart lines', () => {
    expect(plannedLine(wo, 200, 'power_w')[0]).toEqual({ t0: 0, t1: 240, a: 100, b: 150 });
    const climb = repoWorkout('climb-repeats.zwo');
    expect(plannedLine(climb, 200, 'power_w')).toEqual([]);
    expect(plannedLine(climb, 200, 'cadence_rpm')[0]).toEqual({ t0: 420, t1: 600, a: 80, b: 80 });
  });
});

describe('off target', () => {
  const steady: Workout = { name: 't', total: 600, segs: [
    { dur: 300, lo: 1, hi: 1, unit: 'ftp', cad: 90, hr: null, spd: null, name: 'Steady' },
    { dur: 300, lo: null, hi: null, unit: 'ftp', cad: null, hr: 150, spd: 30, name: 'HR' },
  ] };
  const at = (t: number) => workoutAt(steady, t, 200);

  it('power tolerance is 7 %, at least 10 W', () => {
    expect(powerTol(100)).toBe(10);
    expect(powerTol(300)).toBeCloseTo(21);
  });

  it('power low / high at the edge of the tolerance', () => {
    expect(offTarget(at(20), 186, 90, null, null)).toBeNull();          // 200 - 14 = 186: on target
    expect(offTarget(at(20), 185, 90, null, null)).toBe('low');
    expect(offTarget(at(20), 214, 90, null, null)).toBeNull();
    expect(offTarget(at(20), 215, 90, null, null)).toBe('high');
  });

  it('nothing in the first 8 s of a step', () => {
    expect(offTarget(at(7), 50, 90, null, null)).toBeNull();
    expect(offTarget(at(8), 50, 90, null, null)).toBe('low');
  });

  it('power first, then cadence', () => {
    expect(offTarget(at(20), 100, 50, null, null)).toBe('low');
    expect(offTarget(at(20), 200, 90 - CAD_TOL - 1, null, null)).toBe('cad-low');
    expect(offTarget(at(20), 200, 99, null, null)).toBe('cad-high');
  });

  it('speed ±2 km/h, heart rate ±5 bpm only after 30 s', () => {
    expect(offTarget(at(320), null, null, 120, 27.9)).toBe('spd-low');
    expect(offTarget(at(320), null, null, 120, 30)).toBeNull();          // HR still in its 30 s grace
    expect(offTarget(at(330), null, null, 144, 30)).toBe('hr-low');
    expect(offTarget(at(330), null, null, 156, 30)).toBe('hr-high');
    expect(offTarget(at(330), null, null, 155, 32)).toBeNull();
  });

  it('missing readings are not off target', () => {
    expect(offTarget(at(20), null, null, null, null)).toBeNull();
    expect(offTarget(null, 0, 0, 0, 0)).toBeNull();
  });
});

describe('targets on the live tiles', () => {
  const wo: Workout = { name: 't', total: 600, segs: [
    { dur: 300, lo: 0.5, hi: 1.0, unit: 'ftp', cad: 90, hr: 140, spd: 32, grade: 4, name: 'Ramp' },
    { dur: 300, lo: null, hi: null, unit: 'ftp', cad: null, name: 'Free ride' },
  ] };

  it('gives each target the step has, power interpolated', () => {
    const t = tileTargets(workoutAt(wo, 150, 200), 150, 90, 140, 32);
    expect(t.power_w).toEqual({ v: 150, unit: 'W', state: 'ok' });
    expect(t.cadence_rpm?.v).toBe(90);
    expect(t.heart_rate_bpm?.v).toBe(140);
    expect(t.speed_kmh?.v).toBe(32);
    expect(t.grade).toBe(4);
  });

  it('low / high with the beep tolerances', () => {
    const t = tileTargets(workoutAt(wo, 150, 200), 150 - powerTol(150) - 1, 90 + CAD_TOL + 1, 120, 40);
    expect([t.power_w?.state, t.cadence_rpm?.state, t.heart_rate_bpm?.state, t.speed_kmh?.state]).toEqual(['low', 'high', 'low', 'high']);
  });

  it('waits in the first seconds of a step (heart rate longer), without a reading, and while paused', () => {
    expect(tileTargets(workoutAt(wo, 3, 200), 0, 0, 0, 0).power_w?.state).toBe('wait');
    const t = tileTargets(workoutAt(wo, 20, 200), 300, 90, 100, null);
    expect([t.power_w?.state, t.heart_rate_bpm?.state, t.speed_kmh?.state]).toEqual(['high', 'wait', 'wait']);
    expect(tileTargets(workoutAt(wo, 150, 200), 300, 90, 140, 32, true).power_w?.state).toBe('wait');
  });

  it('nothing for a free ride step or after the workout', () => {
    expect(tileTargets(workoutAt(wo, 400, 200), 200, 90, 140, 30)).toEqual({});
    expect(tileTargets(workoutAt(wo, 700, 200), 200, 90, 140, 30)).toEqual({});
  });
});

describe('beep rule: off for more than 7 s, then at most every 15 s', () => {
  const T = 1_700_000_000_000;
  const run = (steps: [number, string | null][], sound = true) => {
    const c: BeepClock = { offSince: null, lastBeep: 0 };
    return steps.filter(([s, off]) => beepDue(c, off as never, T + s * 1000, sound)).map(([s]) => s);
  };
  const every = (from: number, to: number, off: string | null) =>
    Array.from({ length: to - from + 1 }, (_, i) => [from + i, off] as [number, string | null]);

  it('no beep at 7 s, beep at 8 s', () => {
    expect(run(every(0, 7, 'low'))).toEqual([]);
    expect(run(every(0, 8, 'low'))).toEqual([8]);
  });

  it('staying off: beeps at 8 s, 23 s, 38 s', () => {
    expect(run(every(0, 40, 'low'))).toEqual([8, 23, 38]);
  });

  it('back on target resets the 7 s', () => {
    expect(run([...every(0, 6, 'low'), [7, null], ...every(8, 16, 'low')])).toEqual([16]);
  });

  it('switching from too low to too high is no break', () => {
    expect(run([...every(0, 4, 'low'), ...every(5, 9, 'high')])).toEqual([8]);
  });

  it('the 15 s gap holds across separate off periods', () => {
    expect(run([...every(0, 8, 'low'), [9, null], ...every(10, 30, 'low')])).toEqual([8, 23]);
  });

  it('sound off: never', () => {
    expect(run(every(0, 60, 'low'), false)).toEqual([]);
  });

  it('turning sound on while off target beeps at once if it has been more than 7 s', () => {
    const c: BeepClock = { offSince: null, lastBeep: 0 };
    for (let s = 0; s <= 10; s++) beepDue(c, 'low', T + s * 1000, false);
    expect(beepDue(c, 'low', T + 11_000, true)).toBe(true);
  });
});
