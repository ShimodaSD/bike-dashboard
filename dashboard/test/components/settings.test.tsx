// Settings and Training pages: FTP and weight checks, power smoothing, workout loading, Clear data, Stop logger.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/app';
import { Train } from '../../src/train/train';
import type { Workout } from '../../src/types/workout';
import { HR_DEFAULT, type HrSettings } from '../../src/hr/zones';

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

// Settings with real state behind it, like the app (which keeps these in localStorage).
function Harness({ recording = false, canCsv = true, onCsv = () => {} }) {
  const [ftp, setFtp] = useState(200), [kg, setKg] = useState<number | null>(null);
  const [smooth, setSmooth] = useState(0), [liveRate, setLiveRate] = useState<'auto' | 'fast' | 'saver'>('auto');
  const [wo, setWo] = useState<Workout | null>(null), [sound, setSound] = useState(true);
  const [sex, setSex] = useState<'m' | 'f'>('m');
  const [hr, setHr] = useState<HrSettings>(HR_DEFAULT);
  return <>
    <Settings ftp={ftp} setFtp={setFtp} kg={kg} setKg={setKg} sex={sex} setSex={setSex} smooth={smooth} setSmooth={setSmooth}
              liveRate={liveRate} setLiveRate={setLiveRate} onCsv={onCsv} canCsv={canCsv} recording={recording} hr={hr} setHr={setHr} />
    <Train workout={{ wo, setWo, sound, setSound }} />
    <output data-testid="saved">{JSON.stringify({ ftp, kg, smooth, liveRate, wo: wo?.name ?? null, steps: wo?.segs.length, sound, hr })}</output>
  </>;
}
const saved = () => JSON.parse(screen.getByTestId('saved').textContent!);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

describe('FTP', () => {
  it('saves a valid FTP on Enter', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.clear(screen.getByLabelText('FTP'));
    await user.type(screen.getByLabelText('FTP'), '265{Enter}');
    expect(saved().ftp).toBe(265);
  });

  it('refuses out-of-range values and keeps the old one', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    const ftp = screen.getByLabelText('FTP');
    await user.clear(ftp);
    await user.type(ftp, '20');
    await user.tab();
    expect(saved().ftp).toBe(200);
    expect(ftp).toHaveAttribute('aria-invalid', 'true');
    expect(ftp).toHaveValue(200);
    expect(screen.getByText('FTP must be between 50 and 600 W. Kept 200 W.')).toBeInTheDocument();
  });
});

describe('weight', () => {
  it('accepts a comma decimal and rounds to 0.1 kg', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.type(screen.getByLabelText('Weight'), '72,46');
    await user.tab();
    expect(saved().kg).toBe(72.5);
  });

  it('empty clears it; nonsense is flagged', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    const kg = screen.getByLabelText('Weight');
    await user.type(kg, '400');
    await user.tab();
    expect(kg).toHaveAttribute('aria-invalid', 'true');
    expect(saved().kg).toBeNull();
    await user.clear(kg);
    await user.tab();
    expect(kg).toHaveAttribute('aria-invalid', 'false');
  });

  it("shows FTP in W/kg with its level on Coggan's power profile, per table", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    expect(screen.queryByText(/W\/kg ·/)).toBeNull();                  // no weight: nothing to rate
    await user.type(screen.getByLabelText('Weight'), '70');
    await user.tab();
    // 200 W / 70 kg = 2.86 W/kg: Moderate (Cat 4) on both tables; 210 W = 3.00 is Good (Cat 3) for women
    expect(screen.getByText('2.86 W/kg')).toBeInTheDocument();
    expect(screen.getByText('Moderate (Cat 4)')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Power profile'), "Women's table");
    expect(screen.getByText('Moderate (Cat 4)')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('FTP'));
    await user.type(screen.getByLabelText('FTP'), '210{Enter}');      // 3.00 W/kg
    expect(screen.getByText('Good (Cat 3)')).toBeInTheDocument();
  });
});

describe('selects', () => {
  it('power number and live updates', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText('Power number'), '3 s average');
    await user.selectOptions(screen.getByLabelText('Live updates'), 'Battery saver (2 per second)');
    expect(saved()).toMatchObject({ smooth: 3, liveRate: 'saver' });
  });
});

describe('workout', () => {
  const file = (name: string, text: string) => new File([text], name, { type: 'text/xml' });

  it('loads a .zwo and can remove it', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.upload(screen.getByLabelText('Load workout'),
      file('ss.zwo', '<workout_file><name>Sweet spot</name><workout><SteadyState Duration="600" Power="0.9"/></workout></workout_file>'));
    expect(await screen.findByText('Sweet spot')).toBeInTheDocument();     // the file is read async
    expect(saved()).toMatchObject({ wo: 'Sweet spot', steps: 1 });
    expect(screen.getByText(/1 steps · 10:00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(saved().wo).toBeNull();
  });

  it('explains a file it cannot read', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.upload(screen.getByLabelText('Load workout'), file('bad.erg', 'not a workout'));
    expect(await screen.findByText('No [COURSE DATA] section found.')).toHaveClass('err');
    expect(saved().wo).toBeNull();
  });

  it('beep checkbox', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.click(screen.getByLabelText('Beep when off target'));
    expect(saved().sound).toBe(false);
  });
});

describe('this ride', () => {
  it('Export CSV is off until there is a ride', async () => {
    const onCsv = vi.fn();
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<Harness canCsv={false} onCsv={onCsv} />);
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    rerender(<Harness canCsv onCsv={onCsv} />);
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(onCsv).toHaveBeenCalledOnce();
  });

  it('Clear all data waits for the ride to finish', () => {
    render(<Harness recording />);
    expect(screen.getByRole('button', { name: 'Clear all data' })).toBeDisabled();
    expect(screen.getByText(/Finish the ride first/)).toBeInTheDocument();
  });

  it('Clear and Stop need a second press', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Clear all data' }));
    expect(posted()).toEqual([]);
    act(() => vi.advanceTimersByTime(600));
    await user.click(screen.getByRole('button', { name: 'Click again to clear' }));
    await user.click(screen.getByRole('button', { name: 'Stop logger' }));
    act(() => vi.advanceTimersByTime(600));
    await user.click(screen.getByRole('button', { name: 'Click again to stop' }));
    expect(posted()).toEqual(['/clear', '/quit']);
  });
});

describe('heart rate zones', () => {
  it('works out 5 zones from max HR, then keeps a zone edge set by hand', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    expect(screen.getByText(/Set your max heart rate to see the zones/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Max heart rate'), '190{Enter}');
    expect(saved().hr).toEqual({ method: 'max', max: 190, lthr: null, lows: null });
    expect(screen.getByText('133–151 bpm')).toBeInTheDocument();          // Z3 70–80 %
    const z3 = screen.getByLabelText('Z3 starts at (bpm)');
    await user.clear(z3);
    await user.type(z3, '135{Enter}');
    expect(saved().hr.lows).toEqual([114, 135, 152, 171]);
    expect(screen.getByText('114–134 bpm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset to calculated' }));
    expect(saved().hr.lows).toBeNull();
  });

  it('refuses an edge that would overlap the next zone', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.type(screen.getByLabelText('Max heart rate'), '190{Enter}');
    const z2 = screen.getByLabelText('Z2 starts at (bpm)');
    await user.clear(z2);
    await user.type(z2, '140{Enter}');
    expect(saved().hr.lows).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('1–132');
  });

  it('switches to 7 LTHR zones', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText('Zones from'), 'lthr');
    await user.type(screen.getByLabelText('Threshold heart rate (LTHR)'), '170{Enter}');
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('Z5a')).toBeInTheDocument();
    expect(screen.getByText('170–174 bpm')).toBeInTheDocument();          // Z5a 100–102 %
  });
});
