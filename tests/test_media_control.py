"""Music remote: the dashboard's play / pause, next, previous and volume buttons drive the Mac's music."""
import asyncio

import pytest

import media_control as mc
import thinkrider_logger as tl
from helpers.http import request, serve


class FakeMac:
    """Answers the logger's pgrep / osascript calls like a Mac would, and records them."""

    def __init__(self, running=(), states=None, volume=40, trusted=True):
        self.running, self.states, self.volume, self.trusted = set(running), states or {}, volume, trusted
        self.calls = []

    async def __call__(self, *argv):
        self.calls.append(argv)
        if argv[0] == "pgrep":
            return (0 if argv[-1] in self.running else 1), ""
        if argv[1:3] == ("-l", "JavaScript"):
            return 0, ("true" if self.trusted else "false") if argv[4] == mc.TRUSTED_JXA else ""
        script = argv[2]
        if script == mc.VOLUME_GET:
            return 0, str(self.volume)
        if script.startswith("set volume output volume "):
            self.volume = int(script.rsplit(" ", 1)[1])
            return 0, ""
        for app, (state, title, artist) in self.states.items():
            if script == mc.NOW_PLAYING.format(app=app):
                return 0, f"{state}\t{title}\t{artist}"
            if script.startswith(f'tell application "{app}" to ') and "return" not in script:
                return 0, ""
        return 1, ""

    def keys_pressed(self):
        return [int(c[-1]) for c in self.calls if c[1:3] == ("-l", "JavaScript") and c[4] == mc.MEDIA_KEY_JXA]

    def told(self):
        return [c[2] for c in self.calls if c[0] == "osascript" and c[1] == "-e" and c[2].startswith("tell application")
                and "return" not in c[2]]


@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path))
    yield lv
    lv.close()


def media(live, mac):
    m = mc.MediaControl(live, run=mac, platform="darwin")
    m.available = True                       # osascript isn't on the test machine
    return m


def test_other_systems_say_unavailable(live):
    m = mc.MediaControl(live, run=FakeMac(), platform="linux")
    assert live.status["media"]["available"] is False
    assert asyncio.run(m.press("playpause")) is False


def test_shows_the_playing_song_over_a_paused_one(live):
    mac = FakeMac(running={"Spotify", "Music"}, states={"Spotify": ("paused", "A", "x"), "Music": ("playing", "B", "y")})
    asyncio.run(media(live, mac).refresh())
    assert live.status["media"] == {"available": True, "keys": True, "volume": 40,
                                    "now": {"app": "Music", "title": "B", "artist": "y", "playing": True}}


def test_apps_not_running_are_not_asked(live):
    """Asking an app that isn't open would launch it (or ask where it is)."""
    mac = FakeMac(running=set())
    asyncio.run(media(live, mac).refresh())
    assert live.status["media"]["now"] is None
    assert not [c for c in mac.calls if "Spotify" in " ".join(c) and c[0] == "osascript"]


def test_playing_spotify_is_told_directly(live):
    mac = FakeMac(running={"Spotify"}, states={"Spotify": ("playing", "A", "x")})
    m = media(live, mac)
    async def go():
        await m.refresh()
        await m.press("next")
        await m.press("playpause")
    asyncio.run(go())
    assert mac.told() == ['tell application "Spotify" to next track', 'tell application "Spotify" to playpause']
    assert mac.keys_pressed() == []


def test_a_paused_app_we_paused_is_resumed_directly(live):
    mac = FakeMac(running={"Spotify"}, states={"Spotify": ("playing", "A", "x")})
    m = media(live, mac)
    async def go():
        await m.refresh()
        await m.press("playpause")
        mac.states["Spotify"] = ("paused", "A", "x")
        await m.refresh()
        await m.press("playpause")
    asyncio.run(go())
    assert mac.told() == ['tell application "Spotify" to playpause'] * 2


def test_browser_music_gets_media_keys(live):
    """YouTube Music in a browser tab: nothing reports a song, so the Mac's media key is pressed."""
    mac = FakeMac(running=set())
    m = media(live, mac)
    async def go():
        await m.refresh()
        for a in ("playpause", "next", "previous"):
            assert await m.press(a)
    asyncio.run(go())
    assert mac.keys_pressed() == [16, 17, 18]


def test_volume_steps_and_stays_in_range(live):
    mac = FakeMac(volume=97)
    m = media(live, mac)
    asyncio.run(m.press("volup"))
    assert mac.volume == 100 and live.status["media"]["volume"] == 100
    asyncio.run(m.press("voldown"))
    assert mac.volume == 100 - mc.VOLUME_STEP


def test_reports_when_keys_are_not_allowed(live):
    asyncio.run(media(live, FakeMac(trusted=False)).refresh())
    assert live.status["media"]["keys"] is False


def test_http_buttons(live):
    live.media = mc.DemoMedia(live)
    async def go():
        async with serve(live) as port:
            assert (await request(port, "POST", "/media?do=next"))[0] == 200
            assert (await request(port, "POST", "/media?do=format-disk"))[0] == 400
            assert (await request(port, "POST", "/media?do=playpause", {"Origin": "https://evil.example"}))[0] == 403
    asyncio.run(go())
    assert live.status["media"]["now"]["title"] == mc.DemoMedia.SONGS[1][0]
