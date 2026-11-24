// Music panel: add a link, it plays in the service's player, pick another, remove, and the player
// stays on the page (hidden) when the panel is closed so the music keeps going.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MusicButton, MusicPanel } from '../../src/music/music-panel';
import { MAX_SKIPS } from '../../src/music/youtube';

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
  const win = vi.spyOn(window, 'open').mockReturnValue(null);
  await user.click(screen.getByRole('button', { name: 'Small window' }));
  expect(win).toHaveBeenCalledWith('https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP', 'x2max-music', expect.stringContaining('popup'));

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

// The YouTube player posts its events to the page (enablejsapi); see music/youtube.ts.
const ytSays = (id: string, event: string, info: number, source: { postMessage: (m: string, o: string) => void } | null = null) =>
  act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'https://www.youtube.com', data: JSON.stringify({ event, id, info }), source: source as unknown as Window })); });
const YT_SONG = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';

it('says when YouTube blocks the music outside YouTube and offers a small window', async () => {
  const user = userEvent.setup();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /Music/ }));
  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), YT_SONG + '{Enter}');
  expect(player()).toHaveAttribute('src', expect.stringContaining('enablejsapi=1'));
  ytSays('youtube:song:dQw4w9WgXcQ', 'onError', 150);
  expect(screen.getByRole('alert')).toHaveTextContent('doesn’t allow it to play outside YouTube');
  expect(player()).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Play in a small window' }));
  expect(open).toHaveBeenCalledWith('https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'x2max-music', expect.stringContaining('popup'));
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(player()).not.toBeNull();
});

it('skips songs that won’t play in a playlist, and gives up after a few in a row', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: /Music/ }));
  await user.type(screen.getByLabelText('Spotify or YouTube Music link'), YT + '{Enter}');
  const id = 'youtube:playlist:PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
  const frame = { postMessage: vi.fn() };
  ytSays(id, 'onError', 150, frame);
  expect(JSON.parse(frame.postMessage.mock.calls[0][0])).toMatchObject({ event: 'command', func: 'nextVideo' });
  ytSays(id, 'onStateChange', 1, frame);                        // the next song plays: the count starts over
  for (let i = 0; i < MAX_SKIPS; i++) ytSays(id, 'onError', 150, frame);
  expect(player()).not.toBeNull();
  ytSays(id, 'onError', 150, frame);
  expect(screen.getByRole('alert')).toHaveTextContent('outside YouTube');
});
