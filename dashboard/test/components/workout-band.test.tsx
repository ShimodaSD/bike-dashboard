// Workout band: current step and target, on / off target, the popup, and the beep (fake AudioContext).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkoutBand, parseWorkout } from '../../src/workout/workout';

const WO = parseWorkout(`<workout_file><name>Test</name><workout>
  <SteadyState Duration="120" Power="1.0" Cadence="90"/>
  <SteadyState Duration="60" HeartRate="150"/>
</workout></workout_file>`, 't.zwo');

// Counts the tones the band plays: two rising for too low, one falling for too high.
const tones: number[] = [];
class FakeAudio {
  state = 'running'; currentTime = 0; destination = {};
  resume() {}
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: unknown) => x }; }
  createOscillator() {
    const o = { frequency: { value: 0 }, type: '', connect: (g: unknown) => g, start() { tones.push(o.frequency.value); }, stop() {} };
    return o;
  }
}

type Props = Partial<Parameters<typeof WorkoutBand>[0]>;
const band = (p: Props = {}) => <WorkoutBand wo={WO} t={0} mode="recording" ftp={200} power={200} cadence={90}
                                             hr={140} speed={null} sound onRemove={() => {}} {...p} />;

beforeEach(() => {
  tones.length = 0;
  vi.stubGlobal('AudioContext', FakeAudio);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_700_000_000_000);
});

describe('workout band', () => {
  it('before Start: the first step and its target', () => {
    render(band({ mode: 'ready', t: 50 }));
    expect(screen.getByText('Step 1/2 · Steady')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Starts when you press Start');
    expect(screen.getByText('0:00 / 3:00')).toBeInTheDocument();
    expect(screen.getByText('200 W', { exact: false })).toBeInTheDocument();
  });

  it('riding on target: time left and the next step', () => {
    render(band({ t: 30 }));
    expect(screen.getByRole('status')).toHaveTextContent('On target');
    expect(screen.getByText('1:30 left')).toBeInTheDocument();
    expect(screen.getByText('Next: 150 bpm for 1:00')).toBeInTheDocument();
  });

  it('paused: no warning, no beep, says it waits', () => {
    render(band({ t: 30, power: 50, paused: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Paused');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.setSystemTime(1_700_000_020_000);
    render(band({ t: 30, power: 50, paused: true }));
    expect(tones).toEqual([]);
  });

  it('first seconds of a step: get to the target, no warning', () => {
    render(band({ t: 3, power: 50 }));
    expect(screen.getByRole('status')).toHaveTextContent('Get to the target');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('off target: yellow band, no pop-up over the tiles (the Power tile shows how far off)', () => {
    render(band({ t: 30, power: 150 }));
    expect(screen.getByRole('region', { name: 'Workout' })).toHaveClass('off');
    expect(screen.getByRole('status')).toHaveTextContent('Too low · -50 W');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cadence too high', () => {
    render(band({ t: 30, cadence: 105 }));
    expect(screen.getByRole('status')).toHaveTextContent('Cadence too high · +15 rpm');
  });

  it('beeps after more than 7 s off target, then every 15 s, rising tones for too low', () => {
    const { rerender } = render(band({ t: 20, power: 150 }));
    for (let s = 1; s <= 25; s++) {
      vi.setSystemTime(1_700_000_000_000 + s * 1000);
      rerender(band({ t: 20 + s, power: 150 }));
    }
    expect(tones).toEqual([660, 880, 660, 880]);           // at 8 s and 23 s
  });

  it('too high is one falling beep', () => {
    const { rerender } = render(band({ t: 20, power: 260 }));
    vi.setSystemTime(1_700_000_000_000 + 8000);
    rerender(band({ t: 28, power: 260 }));
    expect(tones).toEqual([880, 520]);
  });

  it('no beep with sound off, or before Start', () => {
    const { rerender } = render(band({ t: 20, power: 150, sound: false }));
    vi.setSystemTime(1_700_000_000_000 + 9000);
    rerender(band({ t: 29, power: 150, sound: false }));
    rerender(band({ t: 29, power: 150, mode: 'ready' }));
    expect(tones).toEqual([]);
  });

  it('heart-rate step waits 30 s before judging', () => {
    const { rerender } = render(band({ t: 140, hr: 120 }));
    expect(screen.getByRole('status')).toHaveTextContent('Get to the target');
    rerender(band({ t: 150, hr: 120 }));
    expect(screen.getByRole('status')).toHaveTextContent('Heart rate too low');
  });

  it('workout complete', () => {
    render(band({ t: 200 }));
    expect(screen.getByText('Workout complete.')).toBeInTheDocument();
  });

  it('Remove', async () => {
    const onRemove = vi.fn();
    render(band({ onRemove }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalled();
  });
});
