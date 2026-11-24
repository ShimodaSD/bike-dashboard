// Music remote: the buttons send the Mac's media commands to the logger and show what plays.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MusicPanel } from '../../src/music/music-panel';
import type { MediaStatus } from '../../src/types/feed';

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);
const SPOTIFY: MediaStatus = { available: true, keys: true, volume: 40,
  now: { app: 'Spotify', title: 'Into the Climb', artist: 'The Gradients', playing: true } };

it('shows the song and sends each button to the logger', async () => {
  const user = userEvent.setup();
  render(<MusicPanel media={SPOTIFY} onClose={() => {}} />);
  expect(screen.getByText('Into the Climb')).toBeInTheDocument();
  expect(screen.getByText(/The Gradients · Spotify/)).toBeInTheDocument();
  for (const name of ['Previous', 'Pause', 'Next', 'Volume down', 'Volume up'])
    await user.click(screen.getByRole('button', { name }));
  expect(posted()).toEqual(['/media?do=previous', '/media?do=playpause', '/media?do=next', '/media?do=voldown', '/media?do=volup']);
  expect(screen.getByText('40%')).toBeInTheDocument();
});

it('works without a known song (YouTube Music in the browser)', () => {
  render(<MusicPanel media={{ available: true, keys: true, volume: 30, now: null }} onClose={() => {}} />);
  expect(screen.getByText(/Controls what plays on the Mac/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Play / pause' })).toBeEnabled();
});

it('says how to allow media keys when the Mac refuses them', () => {
  render(<MusicPanel media={{ ...SPOTIFY, keys: false }} onClose={() => {}} />);
  expect(screen.getByText(/Accessibility/)).toBeInTheDocument();
});

it('is off when the logger is not on a Mac', () => {
  render(<MusicPanel media={{ available: false }} onClose={() => {}} />);
  expect(screen.getByText(/runs on a Mac/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('closes on Escape', async () => {
  const onClose = vi.fn();
  render(<MusicPanel media={SPOTIFY} onClose={onClose} />);
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});
