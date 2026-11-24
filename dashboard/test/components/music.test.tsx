// Music panel: add a link, it plays in the service's player, pick another, remove, and the player
// stays on the page (hidden) when the panel is closed so the music keeps going.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { MusicButton, MusicPanel } from '../../src/music/music-panel';

function Harness() {
  const [open, setOpen] = useState(false);
  return <><MusicButton open={open} onToggle={() => setOpen(o => !o)} /><MusicPanel open={open} onClose={() => setOpen(false)} /></>;
}
const SP = 'https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP?si=1';
const YT = 'https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
const player = () => document.querySelector('iframe');

beforeEach(() => localStorage.clear());

it('loads nothing from Spotify or YouTube until opened', async () => {
  localStorage.setItem('x2max.musicPicks', JSON.stringify([{ key: 'spotify:playlist:37i9dQZF1DX76Wlfdnj7AP', service: 'spotify', kind: 'playlist', ref: '37i9dQZF1DX76Wlfdnj7AP', name: 'Climb' }]));
  localStorage.setItem('x2max.musicNow', JSON.stringify('spotify:playlist:37i9dQZF1DX76Wlfdnj7AP'));
  render(<Harness />);
  expect(player()).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Music/ }));
  expect(player()).toHaveAttribute('src', 'https://open.spotify.com/embed/playlist/37i9dQZF1DX76Wlfdnj7AP?theme=0');
});

it('adds links, plays the newest, switches and removes', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /Music/ }));
  expect(screen.getByRole('button', { name: /Music/ })).toHaveAttribute('aria-expanded', 'true');

  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), SP);
  await user.type(screen.getByLabelText('Name (optional)'), 'Climb mix');
  await user.click(screen.getByRole('button', { name: 'Add' }));
  expect(player()).toHaveAttribute('src', expect.stringContaining('open.spotify.com/embed/playlist/'));
  expect(screen.getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute('href', 'https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP');

  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), YT + '{Enter}');
  expect(player()).toHaveAttribute('src', expect.stringContaining('youtube.com/embed/videoseries?list=PLx0'));
  expect(screen.getByRole('button', { name: /^YouTube Music playlist/ })).toHaveAttribute('aria-pressed', 'true');

  await user.click(screen.getByRole('button', { name: /^Climb mix/ }));
  expect(player()).toHaveAttribute('src', expect.stringContaining('spotify'));

  await user.click(screen.getByRole('button', { name: 'Remove Climb mix' }));
  expect(player()).toBeNull();
  expect(screen.getByText('Pick something to play.')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('x2max.musicPicks')!)).toHaveLength(1);
});

it('says why a link cannot be played', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /Music/ }));
  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), 'https://soundcloud.com/x{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Only Spotify and YouTube Music links');
  expect(screen.getByLabelText('Spotify or YouTube Music link')).toHaveAttribute('aria-invalid', 'true');
});

it('keeps the player when closed (Escape), so the music goes on', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /Music/ }));
  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), SP + '{Enter}');
  await user.keyboard('{Escape}');
  expect(document.getElementById('music')).not.toHaveClass('open');
  expect(player()).not.toBeNull();
});
