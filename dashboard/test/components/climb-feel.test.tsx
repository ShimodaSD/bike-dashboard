// Climb feel in the Trainer control band: trainer difficulty, rolling and wind resistance, sent to the logger.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClimbFeel, SIM_DEFAULTS } from '../../src/control/climb-feel';
import { ClimbBand } from '../../src/control/climb';
import { control } from '../fixtures/status';

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

describe('Climb feel', () => {
  it('quick difficulty is sent and shown at once', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbFeel sim={SIM_DEFAULTS} />);
    expect(screen.getByText('The trainer gets the real grade.', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '50 %' }));
    expect(posted()).toEqual(['/control/sim?difficulty=50']);
    expect(screen.getByRole('status', { name: 'Trainer difficulty' })).toHaveTextContent('50 %');
    expect(screen.getByText('5 %')).toBeInTheDocument();             // a 10 % climb feels like 5 %
  });

  it('− / + step 5 % and stop at the limits', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<ClimbFeel sim={SIM_DEFAULTS} />);
    await user.click(screen.getByRole('button', { name: 'Trainer difficulty down' }));
    await user.click(screen.getByRole('button', { name: 'Trainer difficulty down' }));
    expect(posted()).toEqual(['/control/sim?difficulty=95', '/control/sim?difficulty=90']);
    expect(screen.getByRole('status', { name: 'Trainer difficulty' })).toHaveTextContent('90 %');
    act(() => { vi.advanceTimersByTime(2000); });                   // logger never confirmed: back to its value
    expect(screen.getByRole('status', { name: 'Trainer difficulty' })).toHaveTextContent('100 %');
    rerender(<ClimbFeel sim={{ ...SIM_DEFAULTS, difficulty: 150 }} />);
    expect(screen.getByRole('button', { name: 'Trainer difficulty up' })).toBeDisabled();
    rerender(<ClimbFeel sim={{ ...SIM_DEFAULTS, difficulty: 0 }} />);
    expect(screen.getByRole('button', { name: 'Trainer difficulty down' })).toBeDisabled();
  });

  it('rolling resistance presets, and a custom value from the logger is kept', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<ClimbFeel sim={SIM_DEFAULTS} />);
    await user.selectOptions(screen.getByLabelText('Rolling resistance'), 'Gravel (0.008)');
    expect(posted()).toEqual(['/control/sim?crr=0.008']);
    rerender(<ClimbFeel sim={{ ...SIM_DEFAULTS, crr: 0.0051 }} />);
    expect(screen.getByLabelText('Rolling resistance')).toHaveDisplayValue('Custom (0.0051)');
  });

  it('wind resistance: valid values are sent, others refused', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ClimbFeel sim={SIM_DEFAULTS} />);
    const cw = screen.getByLabelText('Wind resistance');
    await user.clear(cw);
    await user.type(cw, '0,4{Enter}');
    expect(posted()).toEqual(['/control/sim?cw=0.4']);
    await user.clear(cw);
    await user.type(cw, '9{Enter}');
    expect(posted()).toHaveLength(1);
    expect(cw).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/must be between 0.1 and 1.5 kg\/m/)).toBeInTheDocument();
  });

  it('reset sends the defaults, and is off when already default', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<ClimbFeel sim={SIM_DEFAULTS} />);
    expect(screen.getByRole('button', { name: 'Reset climb feel' })).toBeDisabled();
    rerender(<ClimbFeel sim={{ difficulty: 40, crr: 0.008, cw: 0.3 }} />);
    await user.click(screen.getByRole('button', { name: 'Reset climb feel' }));
    expect(posted()).toEqual(['/control/sim?difficulty=100&crr=0.004&cw=0.51']);
  });
});

describe('Trainer control band with a lower difficulty', () => {
  it('says what the climb feels like', () => {
    render(<ClimbBand ctl={control({ enabled: true, state: 'on', grade: 8, trainer_grade: 4,
                                     sim: { difficulty: 50, crr: 0.004, cw: 0.51 } })} ftp={200} follow={null} />);
    expect(screen.getByText(/At 50 % difficulty/)).toHaveTextContent('the trainer feels 4.0 %');
  });

  it('shows Climb feel on Live in Climb mode and while off, not in ERG', () => {
    const { rerender } = render(<ClimbBand ctl={control()} ftp={200} follow={null} />);
    expect(screen.getByRole('group', { name: 'Climb feel' })).toBeInTheDocument();
    rerender(<ClimbBand ctl={control({ enabled: true, state: 'on', grade: 8, trainer_grade: 8 })} ftp={200} follow={null} />);
    expect(screen.getByRole('group', { name: 'Climb feel' })).toBeInTheDocument();
    expect(screen.queryByText(/% difficulty/)).toBeNull();          // 100 %: nothing to explain
    rerender(<ClimbBand ctl={control({ enabled: true, state: 'on', mode: 'erg' })} ftp={200} follow={null} />);
    expect(screen.queryByRole('group', { name: 'Climb feel' })).toBeNull();
  });
});
