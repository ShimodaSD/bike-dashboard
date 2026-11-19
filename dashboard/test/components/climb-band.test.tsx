// Trainer control band: the switch, states and messages, Climb / ERG, the grade dial.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClimbBand } from '../../src/control/climb';
import { control } from '../fixtures/status';

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

describe('Trainer control band', () => {
  it('off: the switch turns it on', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbBand ctl={control()} ftp={200} follow={null} />);
    const sw = screen.getByRole('switch', { name: 'Trainer control' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Simulate climbs/)).toBeInTheDocument();
    await user.click(sw);
    expect(posted()).toEqual(['/control?on=1']);
  });

  it('unsupported trainer: switch disabled, reason shown', () => {
    render(<ClimbBand ctl={control({ state: 'unsupported', msg: "This trainer has no FTMS control point, so it can't simulate climbs." })}
                      ftp={200} follow={null} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('no FTMS control point');
    expect(screen.getByText('Not available')).toHaveClass('bad');
  });

  it('lost control says why', () => {
    render(<ClimbBand ctl={control({ state: 'lost', msg: 'Another app took control of the trainer. Trainer control is off.' })}
                      ftp={200} follow={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Another app took control');
  });

  it('on in Climb: quick grades, nudges and limits', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', grade: 15 })} ftp={200} follow={null} />);
    expect(screen.getByRole('button', { name: 'Grade up' })).toBeDisabled();       // 15 % is the top
    await user.click(screen.getByRole('button', { name: '6 %' }));
    expect(screen.getByRole('button', { name: '6 %' })).toHaveClass('on');          // shows at once (draft)
    await user.click(screen.getByRole('button', { name: 'Grade down' }));
    expect(posted()).toEqual(['/control/grade?pct=6', '/control/grade?pct=5.5']);
    expect(screen.getByText('Back to 0 % when you finish or the trainer disconnects.', { exact: false })).toBeInTheDocument();
  });

  it('the draft falls back to the trainer’s grade if it never confirms', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', grade: 0 })} ftp={200} follow={null} />);
    await user.click(screen.getByRole('button', { name: '10 %' }));
    expect(screen.getByRole('status', { name: 'Grade' })).toHaveTextContent('10.0%');
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole('status', { name: 'Grade' })).toHaveTextContent('0.0%');
  });

  it('dragging the slider sends at most every 150 ms, and the last value', () => {
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', grade: 0 })} ftp={200} follow={null} />);
    const slider = screen.getByRole('slider', { name: 'Grade' });
    for (const v of ['1', '1.5', '2', '2.5']) {
      fireEvent.change(slider, { target: { value: v } });
      act(() => vi.advanceTimersByTime(20));
    }
    act(() => vi.advanceTimersByTime(200));
    expect(posted()).toEqual(['/control/grade?pct=1', '/control/grade?pct=2.5']);
  });

  it('ERG: quick targets from FTP within the trainer range', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', mode: 'erg', power_w: 200, power_range: [80, 250] })} ftp={300} follow={null} />);
    expect(screen.getAllByRole('button', { name: /W$/ }).map(b => b.textContent)).toEqual(['165 W', '225 W', '250 W']);   // 90 % and 105 % both clamp to 250 W: one button
    await user.click(screen.getByRole('button', { name: 'Climb' }));
    expect(posted()).toEqual(['/control/grade?pct=0']);
  });

  it('ERG disabled on a trainer without it', () => {
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', supports: { sim: true, erg: false } })} ftp={200} follow={null} />);
    expect(screen.getByRole('button', { name: 'ERG' })).toBeDisabled();
  });

  it('says when a workout drives it', () => {
    render(<ClimbBand ctl={control({ enabled: true, state: 'on' })} ftp={200} follow="Workout steps with a grade set it when they start." />);
    expect(screen.getByText(/Workout steps with a grade set it/)).toBeInTheDocument();
  });
});
