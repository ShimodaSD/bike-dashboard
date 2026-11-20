// FTP test helpers: the protocol as a workout, the 20 minute window and the live estimate.
import { describe, expect, it } from 'vitest';
import { protocolWorkout, riderTip, testProgress, testWindow, totalMinutes } from '../../src/ftp/ftp';
import { workoutAt } from '../../src/workout/workout';
import { ride } from '../fixtures/ride';
import { PROTOCOL, ftpStatus } from '../fixtures/ftp';

const run = (over = {}) => ftpStatus({ ...over }).test!;

describe('protocol', () => {
  it('the 20 minutes come after warm-up, 5 min hard and 10 min easy', () => {
    expect(testWindow(PROTOCOL)).toEqual({ start: 1500, end: 2700 });
    expect(totalMinutes(PROTOCOL)).toBe(55);
  });

  it('becomes a workout whose hard efforts have no power target', () => {
    const wo = protocolWorkout(PROTOCOL);
    expect(wo.total).toBe(3300);
    expect(workoutAt(wo, 0, 200)!.target).toBe(100);           // warm-up starts at 50 %
    expect(workoutAt(wo, 700, 200)!.target).toBeNull();        // 5 min hard
    expect(workoutAt(wo, 1600, 200)!.s.name).toBe('20 min test');
    expect(workoutAt(wo, 1600, 200)!.target).toBeNull();
  });
});

describe('progress', () => {
  it('counts down to the 20 minutes', () => {
    expect(testProgress(ride(new Array(100).fill(150)), run(), PROTOCOL, 0.95)).toEqual({ phase: 'before', until: 1400 });
  });

  it('in the 20 minutes: average so far and the FTP it gives', () => {
    const hist = ride([...new Array(1500).fill(120), ...new Array(300).fill(250), ...new Array(300).fill(270)]);
    const p = testProgress(hist, run(), PROTOCOL, 0.95);
    expect(p).toEqual({ phase: 'test', into: 600, left: 600, avg: 260, ftp: 247 });
  });

  it('first second of the 20 minutes has no average yet', () => {
    const p = testProgress(ride(new Array(1500).fill(120)), run(), PROTOCOL, 0.95);
    expect(p).toMatchObject({ phase: 'test', into: 0, avg: null, ftp: null });
  });

  it('after the 20 minutes, or once the logger says done', () => {
    expect(testProgress(ride(new Array(2700).fill(200)), run(), PROTOCOL, 0.95)).toEqual({ phase: 'after' });
    expect(testProgress(ride(new Array(1600).fill(200)), run({ state: 'done' }), PROTOCOL, 0.95)).toEqual({ phase: 'after' });
  });
});

describe('guidance for the rider', () => {
  const tip = (t: number, ref = 220) => riderTip(ride(new Array(t).fill(150)), run(), PROTOCOL, 0.95, ref);

  it('each step says what to do', () => {
    expect(tip(10)).toMatch(/^Easy spin.*Fan on/);
    expect(tip(700)).toMatch(/^Hard but controlled/);
    expect(tip(1000)).toMatch(/^Recover/);
    expect(tip(3000)).toMatch(/^Spin easy/);
    expect(tip(4000)).toMatch(/^Spin easy/);                  // past the protocol
  });

  it('paces the 20 minutes: start near FTP ÷ 0.95, steady, then empty the tank', () => {
    expect(tip(1500)).toBe('Start a little conservative, near 230 W. Going out too hard is the most common mistake; you can raise it later.');
    expect(tip(1500, 250)).toContain('near 265 W');
    expect(tip(2000)).toMatch(/^Hold it steady/);
    expect(tip(2450)).toMatch(/^Last 5 minutes/);
    expect(tip(2650)).toBe('Last minute: empty the tank.');
  });
});
