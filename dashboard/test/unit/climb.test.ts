// Trainer control from the dashboard: the − / + keys and workout steps driving the trainer.
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { controlKey, fmtGrade, useWorkoutControl } from '../../src/control/climb';
import { parseWorkout, workoutAt } from '../../src/workout/workout';
import type { ControlStatus } from '../../src/types/feed';

const ctl = (over: Partial<ControlStatus> = {}): ControlStatus => ({
  enabled: true, state: 'on', mode: 'sim', grade: 3, power_w: 200, msg: null,
  supports: { sim: true, erg: true }, power_range: [50, 1000], ...over,
});
const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);
const key = (k: string) => new KeyboardEvent('keydown', { key: k, cancelable: true });

describe('− / + keys', () => {
  it('grade ±0.5 % in Climb, ±5 W in ERG', () => {
    controlKey(key('+'), ctl());
    controlKey(key('-'), ctl());
    controlKey(key('='), ctl({ mode: 'erg' }));
    controlKey(key('_'), ctl({ mode: 'erg' }));
    expect(posted()).toEqual(['/control/grade?pct=3.5', '/control/grade?pct=2.5', '/control/power?w=205', '/control/power?w=195']);
  });

  it('stops at −5 % and 15 %', () => {
    controlKey(key('+'), ctl({ grade: 15 }));
    controlKey(key('-'), ctl({ grade: -5 }));
    expect(posted()).toEqual(['/control/grade?pct=15', '/control/grade?pct=-5']);
  });

  it('does nothing while control is off, connecting or for other keys', () => {
    controlKey(key('+'), ctl({ enabled: false }));
    controlKey(key('+'), ctl({ state: 'connecting' }));
    controlKey(key('+'), undefined);
    const e = key('a');
    controlKey(e, ctl());
    expect(posted()).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('formats the grade with a real minus sign', () => {
    expect([fmtGrade(6), fmtGrade(0), fmtGrade(-2.5)]).toEqual(['6.0', '0.0', '−2.5']);
  });
});

describe('workout steps drive the trainer', () => {
  const climb = parseWorkout(`<workout_file><workout><FreeRide Duration="60" Grade="2"/><FreeRide Duration="60" Grade="6"/>
    <SteadyState Duration="60" Power="0.8"/><Ramp Duration="60" PowerLow="0.5" PowerHigh="1"/></workout></workout_file>`, 'c.zwo');
  const hook = (c: ControlStatus | undefined, recording = true, t = 0) =>
    renderHook(({ t }) => useWorkoutControl({ ctl: c, at: workoutAt(climb, t, 200), recording }), { initialProps: { t } });

  it('sends each step’s grade once, when the step starts', () => {
    const { rerender } = hook(ctl());
    for (let t = 1; t < 120; t++) rerender({ t });
    expect(posted()).toEqual(['/control/grade?pct=2', '/control/grade?pct=6']);
  });

  it('ERG: power targets, ramps in 5 W steps', () => {
    const { rerender } = hook(ctl({ mode: 'erg' }), true, 120);
    for (let t = 121; t < 240; t++) rerender({ t });
    const sent = posted();
    expect(sent[0]).toBe('/control/power?w=160');
    expect(sent[1]).toBe('/control/power?w=100');
    expect(sent.at(-1)).toBe('/control/power?w=200');
    sent.slice(1).forEach((s, i) => expect(s).not.toBe(sent[i]));   // a new value only when it changes
    expect(sent).toHaveLength(2 + 20);                  // 160, then 100, 105 … 200
  });

  it('nothing when control is off or not recording', () => {
    hook(ctl({ enabled: false }));
    hook(ctl(), false);
    hook(undefined);
    expect(posted()).toEqual([]);
  });
});
