// Music links: which Spotify / YouTube Music share links become a player, and which explain why not.
import { describe, expect, it } from 'vitest';
import { addPick, embedUrl, openUrl, parseMusicLink, type MusicPick } from '../../src/music/music';

const pick = (text: string, name = '') => {
  const r = parseMusicLink(text, name);
  if ('error' in r) throw new Error(r.error);
  return r.pick;
};
const error = (text: string) => {
  const r = parseMusicLink(text);
  return 'error' in r ? r.error : null;
};
const SP = '37i9dQZF1DX76Wlfdnj7AP';

describe('Spotify links', () => {
  it('reads share links, with or without the language part and tracking', () => {
    expect(pick(`https://open.spotify.com/playlist/${SP}?si=abc123`)).toMatchObject({ service: 'spotify', kind: 'playlist', ref: SP, name: 'Spotify playlist' });
    expect(pick(`https://open.spotify.com/intl-pt/album/${SP}`)).toMatchObject({ kind: 'album', ref: SP });
    expect(pick(`open.spotify.com/track/${SP}`)).toMatchObject({ kind: 'track', name: 'Spotify song' });
    expect(pick(`spotify:artist:${SP}`)).toMatchObject({ kind: 'artist' });
  });
  it('embeds in the dark player', () => {
    const p = pick(`https://open.spotify.com/playlist/${SP}`, 'Climb mix');
    expect(p.name).toBe('Climb mix');
    expect(embedUrl(p)).toBe(`https://open.spotify.com/embed/playlist/${SP}?theme=0`);
    expect(openUrl(p)).toBe(`https://open.spotify.com/playlist/${SP}`);
  });
  it('explains short links and other pages', () => {
    expect(error('https://spotify.link/AbCdEf')).toMatch(/Short Spotify links/);
    expect(error('https://open.spotify.com/user/someone')).toMatch(/not a song, album/);
  });
});

describe('YouTube Music links', () => {
  it('plays a playlist, starting on the song the link had', () => {
    const p = pick('https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    expect(p).toMatchObject({ service: 'youtube', kind: 'playlist', name: 'YouTube Music playlist' });
    expect(embedUrl(p)).toMatch(/^https:\/\/www\.youtube\.com\/embed\/videoseries\?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&autoplay=1/);
    const w = pick('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=OLAK5uy_kXyZ0123456789abcdefghijklmnopq');
    expect(embedUrl(w)).toMatch(/\/embed\/dQw4w9WgXcQ\?list=OLAK5uy_/);
    expect(openUrl(w)).toBe('https://music.youtube.com/playlist?list=OLAK5uy_kXyZ0123456789abcdefghijklmnopq');
  });
  it('plays a single song from music.youtube.com, youtube.com or youtu.be', () => {
    expect(pick('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x')).toMatchObject({ kind: 'song', ref: 'dQw4w9WgXcQ' });
    expect(pick('https://youtu.be/dQw4w9WgXcQ?si=x')).toMatchObject({ kind: 'song', ref: 'dQw4w9WgXcQ' });
    expect(embedUrl(pick('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(
      `https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`);
  });
  it('reads the share link with its tracking parameters', () => {
    const p = pick('https://music.youtube.com/playlist?list=PLyrLTfUQELB72xgoCCBGNEyD6G4bIDcbJ&si=dNi0DQDCGWUZz0hn&drli=1');
    expect(embedUrl(p)).toMatch(/^https:\/\/www\.youtube\.com\/embed\/videoseries\?list=PLyrLTfUQELB72xgoCCBGNEyD6G4bIDcbJ&/);
  });
  it('skips personal mixes (they do not play embedded) but keeps the song', () => {
    expect(pick('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ')).toMatchObject({ kind: 'song' });
  });
  it('explains album pages and links with nothing to play', () => {
    expect(error('https://music.youtube.com/browse/MPREb_abc')).toMatch(/Album and artist pages/);
    expect(error('https://www.youtube.com/')).toMatch(/no playlist or song/);
  });
});

it('refuses other sites and empty input', () => {
  expect(error('')).toMatch(/Paste a link/);
  expect(error('https://soundcloud.com/x')).toMatch(/Only Spotify and YouTube Music/);
  expect(error('not a link at all')).toBeTruthy();
});

it('keeps the newest first, without duplicates, up to the limit', () => {
  const a = pick(`spotify:playlist:${SP}`), b = pick('https://youtu.be/dQw4w9WgXcQ');
  let list: MusicPick[] = [];
  list = addPick(list, a); list = addPick(list, b); list = addPick(list, a);
  expect(list.map(p => p.key)).toEqual([a.key, b.key]);
  expect(addPick([a, b], pick(`spotify:album:${SP}`), 2).map(p => p.kind)).toEqual(['album', 'playlist']);
});
