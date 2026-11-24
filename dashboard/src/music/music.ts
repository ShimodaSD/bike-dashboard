// Music while riding: links from Spotify or YouTube Music, played in the services' own embedded
// players. No account setup or API key: the players run as the rider in this browser, so being
// signed in to Spotify (full songs) or YouTube Premium (no ads) here is what unlocks the full thing.
// YouTube Music has no public API of its own; its playlists and songs are YouTube ids and play in
// the YouTube player.

export type MusicService = 'spotify' | 'youtube';

export interface MusicPick {
  key: string;                 // service:kind:ref, the same link twice is one pick
  service: MusicService;
  kind: string;                // playlist, album, track, artist, episode, show (Spotify) / playlist, song (YouTube)
  ref: string;                 // Spotify id, or YouTube list id (playlist) / video id (song)
  video?: string;              // YouTube: the song a playlist link started on
  name: string;
}

export const SERVICE_NAME: Record<MusicService, string> = { spotify: 'Spotify', youtube: 'YouTube Music' };

const SPOTIFY_KINDS = ['track', 'album', 'playlist', 'artist', 'episode', 'show'];
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{12,64}$/;
const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];

export type ParseResult = { pick: MusicPick } | { error: string };

const KIND_WORD: Record<string, string> = { track: 'song', song: 'song', episode: 'episode', show: 'podcast' };
export const kindWord = (p: Pick<MusicPick, 'kind'>) => KIND_WORD[p.kind] ?? p.kind;
const defaultName = (service: MusicService, kind: string) => `${SERVICE_NAME[service]} ${KIND_WORD[kind] ?? kind}`;

function make(service: MusicService, kind: string, ref: string, name: string, video?: string): ParseResult {
  return { pick: { key: `${service}:${kind}:${ref}`, service, kind, ref, ...(video ? { video } : {}),
                   name: name.trim().slice(0, 60) || defaultName(service, kind) } };
}

/** A pasted share link (or spotify: URI) to a pick, or why it can't be played here. */
export function parseMusicLink(text: string, name = ''): ParseResult {
  const raw = text.trim();
  if (!raw) return { error: 'Paste a link from Spotify or YouTube Music.' };
  const uri = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(raw);
  if (uri) {
    return SPOTIFY_KINDS.includes(uri[1]) && SPOTIFY_ID.test(uri[2]) ? make('spotify', uri[1], uri[2], name)
      : { error: 'That Spotify link is not a song, album, playlist, artist or podcast.' };
  }
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); }
  catch { return { error: 'That is not a link. In the app use Share › Copy link, then paste it here.' }; }
  const host = url.hostname.toLowerCase();

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const m = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?([a-z]+)\/([A-Za-z0-9]+)/i.exec(url.pathname);
    if (m && SPOTIFY_KINDS.includes(m[1].toLowerCase()) && SPOTIFY_ID.test(m[2])) return make('spotify', m[1].toLowerCase(), m[2], name);
    return { error: 'That Spotify link is not a song, album, playlist, artist or podcast.' };
  }
  if (host === 'spotify.link' || host.endsWith('.app.link')) {
    return { error: 'Short Spotify links can’t be read here. Open it, then copy the open.spotify.com link from the address bar.' };
  }

  if (YT_HOSTS.includes(host) || host === 'youtu.be') {
    const list = url.searchParams.get('list') ?? '';
    const v = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v') ?? '';
    // Radio and "My mix" lists are made for one account and don't play embedded
    if (YT_LIST.test(list) && !/^RD(?!CLAK)/.test(list)) return make('youtube', 'playlist', list, name, YT_VIDEO.test(v) ? v : undefined);
    if (YT_VIDEO.test(v)) return make('youtube', 'song', v, name);
    if (url.pathname.startsWith('/browse/') || url.pathname.startsWith('/channel/')) {
      return { error: 'Album and artist pages can’t be embedded. Use Share › Copy link on the album, or on a playlist or song.' };
    }
    return { error: 'That YouTube link has no playlist or song in it.' };
  }
  return { error: 'Only Spotify and YouTube Music links can be played here.' };
}

/** The address of the service's embedded player. */
export function embedUrl(p: MusicPick): string {
  if (p.service === 'spotify') return `https://open.spotify.com/embed/${p.kind}/${p.ref}?theme=0`;
  // youtube.com (not -nocookie) so a YouTube Premium sign-in in this browser counts: no ads
  const q = 'autoplay=1&playsinline=1&rel=0';
  return p.kind === 'playlist'
    ? `https://www.youtube.com/embed/${p.video ?? 'videoseries'}?list=${p.ref}&${q}`
    : `https://www.youtube.com/embed/${p.ref}?${q}`;
}

/** The same music in the service's own app or site. */
export function openUrl(p: MusicPick): string {
  if (p.service === 'spotify') return `https://open.spotify.com/${p.kind}/${p.ref}`;
  return p.kind === 'playlist' ? `https://music.youtube.com/playlist?list=${p.ref}` : `https://music.youtube.com/watch?v=${p.ref}`;
}

/** The pick list after adding one: newest first, a link already there moves to the top, at most `max`. */
export const MAX_PICKS = 24;
export const addPick = (picks: MusicPick[], p: MusicPick, max = MAX_PICKS) => [p, ...picks.filter(x => x.key !== p.key)].slice(0, max);
