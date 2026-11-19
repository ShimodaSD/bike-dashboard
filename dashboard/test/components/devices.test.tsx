// Devices drawer: what each slot says, connecting a found device, turning search off and on.
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Devices } from '../../src/app';
import { status } from '../fixtures/status';
import type { FoundDevice } from '../../src/types/feed';

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);
const FOUND: FoundDevice[] = [
  { address: 'T1', name: 'THINK X2MAX', rssi: -50, kind: 'trainer' },
  { address: 'W2', name: 'HRM-Dual', rssi: -82, kind: 'hr' },
  { address: 'S1', name: 'Speaker', rssi: -70, kind: 'other' },
];
const slot = (title: string) => screen.getByText(title, { selector: '.flabel' }).closest('.slot') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

describe('Devices', () => {
  it('scans when it opens', () => {
    render(<Devices status={status()} recording={false} />);
    expect(posted()).toEqual(['/devices/scan']);
  });

  it('connected slots and the found list', () => {
    render(<Devices status={status({ scan: { state: 'done', found: FOUND } })} recording={false} />);
    expect(within(slot('Trainer')).getByText('THINK X2MAX')).toBeInTheDocument();
    expect(within(slot('Trainer')).getByText(/^Connected/)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);                                      // "other" hidden at first
    expect(within(rows[0]).getByText('Trainer')).toHaveClass('badge');  // in use
    expect(within(rows[1]).getByRole('img')).toHaveAccessibleName('Signal Weak');
  });

  it('Connect posts the device for its role', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Devices status={status({ scan: { state: 'done', found: FOUND } })} recording={false} />);
    await user.click(screen.getByRole('button', { name: 'Use HRM-Dual for heart rate' }));
    expect(posted()).toContain('/devices/use?role=hr&address=W2&name=HRM-Dual');
  });

  it('other devices can be used for either role', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Devices status={status({ scan: { state: 'done', found: FOUND } })} recording={false} />);
    await user.click(screen.getByRole('button', { name: 'Show other devices (1)' }));
    expect(screen.getByRole('button', { name: 'Use Speaker for trainer' })).toHaveTextContent('As trainer');
    expect(screen.getByRole('button', { name: 'Use Speaker for heart rate' })).toBeInTheDocument();
  });

  it('dropping the trainer mid-ride needs a second press', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Devices status={status()} recording />);
    const btn = () => within(slot('Trainer')).getByRole('button');
    await user.click(btn());
    expect(btn()).toHaveTextContent('Click again (pauses the ride)');
    expect(posted()).toEqual(['/devices/scan']);
    act(() => vi.advanceTimersByTime(600));
    await user.click(btn());
    expect(posted()).toContain('/devices/off?role=trainer');
  });

  it('heart rate drops with one press, even mid-ride', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Devices status={status()} recording />);
    await user.click(within(slot('Heart rate')).getByRole('button', { name: 'Disconnect and stop searching' }));
    expect(posted()).toContain('/devices/off?role=hr');
  });

  it('search off: turn it back on for the saved device or any', async () => {
    const user = userEvent.setup({ delay: null });
    const st = status({ state: 'off', devices: { trainer: { mode: 'off', address: 'T1', name: 'THINK X2MAX' }, hr: { mode: 'auto' } } });
    render(<Devices status={st} recording={false} />);
    expect(within(slot('Trainer')).getByText(/Search is off/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search for THINK X2MAX' }));
    await user.click(screen.getByRole('button', { name: 'Search for any' }));
    expect(posted()).toEqual(['/devices/scan', '/devices/search?role=trainer', '/devices/auto?role=trainer']);
  });

  it('scanning, nothing found and scan errors', () => {
    const { rerender } = render(<Devices status={status({ scan: { state: 'scanning', found: [] } })} recording={false} />);
    expect(screen.getByRole('button', { name: 'Scanning…' })).toBeDisabled();
    rerender(<Devices status={status({ scan: { state: 'done', found: [] } })} recording={false} />);
    expect(screen.getByText(/No trainer or heart-rate broadcast found/)).toBeInTheDocument();
    rerender(<Devices status={status({ scan: { state: 'error', found: [], error: 'Bluetooth is off' } })} recording={false} />);
    expect(screen.getByText('Bluetooth scan failed: Bluetooth is off')).toBeInTheDocument();
  });
});
