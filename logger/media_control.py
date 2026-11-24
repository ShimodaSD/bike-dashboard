"""Music remote: play / pause, next, previous and volume for whatever plays on this Mac, from the
dashboard (on the laptop or on a phone on the same Wi-Fi).

The logger runs on the Mac, so it can press the Mac's own media keys: they go to whatever played
last, which covers YouTube Music in a browser tab as well as the Spotify and Music apps. No account,
API key or embedded player.

- Spotify / Music playing: they are told directly with AppleScript (macOS asks once to let the
  Terminal control them), and their song is shown on the dashboard.
- Anything else (YouTube Music in the browser): a media key press. Posting a key needs the app that
  runs the logger (Terminal) to be allowed under System Settings > Privacy & Security >
  Accessibility; status["media"]["keys"] says whether it is.
- Volume: the Mac's output volume (AppleScript, no permission needed).

Other systems get status["media"] = {"available": False}. --demo simulates a player.

status["media"] = {"available": bool, "keys": bool | None, "volume": int | None,
                   "now": None | {"app", "title", "artist", "playing"}}
"""
import asyncio
import shutil
import sys

ACTIONS = ("playpause", "next", "previous", "volup", "voldown")
APPS = ("Spotify", "Music")                  # apps that report their song (process names)
POLL_S = 3                                    # now-playing refresh while a dashboard is open
VOLUME_STEP = 6                               # % per press (about one Mac volume notch)
TIMEOUT_S = 4

# NX_KEYTYPE_* codes of the Mac's media keys
KEYCODE = {"playpause": 16, "next": 17, "previous": 18}

# A system-defined key event, down then up: what the play/next/previous keys on the keyboard send.
MEDIA_KEY_JXA = """
ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
function run(argv) {
  var k = parseInt(argv[0], 10);
  [0xa, 0xb].forEach(function (st) {
    var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, $.NSMakePoint(0, 0), st << 8, 0, 0, null, 8, (k << 16) | (st << 8), -1);
    $.CGEventPost(0, ev.CGEvent);
  });
}
"""
TRUSTED_JXA = "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted();"

APP_COMMAND = {"playpause": "playpause", "next": "next track", "previous": "previous track"}
NOW_PLAYING = ('tell application "{app}" to return (player state as string) & tab & '
               '(name of current track) & tab & (artist of current track)')
VOLUME_GET = "output volume of (get volume settings)"
VOLUME_SET = "set volume output volume {v}"


async def run_cmd(*argv):
    """Run a command; (exit code, stdout). Never raises: a missing tool or a hang is (-1, "")."""
    try:
        p = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), TIMEOUT_S)
        return p.returncode, out.decode("utf-8", "replace").strip()
    except (OSError, asyncio.TimeoutError):
        return -1, ""


class MediaControl:
    """The Mac's music, from the dashboard. `run` is swapped in tests."""

    def __init__(self, live, run=run_cmd, platform=sys.platform):
        self.live = live
        self.run = run
        self.available = platform == "darwin" and shutil.which("osascript") is not None
        self.keys = None                       # may post media keys (Accessibility); None = not checked
        self.task = None
        self.polls = 0
        self.last_app = None                   # the app the last button told directly
        live.status["media"] = {"available": self.available, "keys": None, "volume": None, "now": None}

    def start(self):
        if self.available:
            self.task = asyncio.ensure_future(self._loop())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _loop(self):
        while True:
            if self.live.clients:              # only while someone looks: osascript costs a little
                await self.refresh()
            await asyncio.sleep(POLL_S)

    # -- reading ---------------------------------------------------------------
    async def _osa(self, script):
        return await self.run("osascript", "-e", script)

    async def running_apps(self):
        found = []
        for app in APPS:
            code, _ = await self.run("pgrep", "-xq", app)
            if code == 0:
                found.append(app)
        return found

    async def now_playing(self):
        """The Spotify / Music song: the one playing, else the first paused one. None if neither."""
        best = None
        for app in await self.running_apps():
            code, out = await self._osa(NOW_PLAYING.format(app=app))
            parts = out.split("\t")
            if code != 0 or len(parts) < 3 or parts[0] not in ("playing", "paused"):
                continue
            song = {"app": app, "title": parts[1], "artist": parts[2], "playing": parts[0] == "playing"}
            if song["playing"]:
                return song
            best = best or song
        return best

    async def volume(self):
        code, out = await self._osa(VOLUME_GET)
        return int(out) if code == 0 and out.isdigit() else None

    async def refresh(self):
        now, vol = await self.now_playing(), await self.volume()
        if self.keys is None or self.polls % 20 == 0:          # permission can change in Settings
            code, out = await self.run("osascript", "-l", "JavaScript", "-e", TRUSTED_JXA)
            self.keys = code == 0 and out == "true"
        self.polls += 1
        media = {"available": True, "keys": self.keys, "volume": vol, "now": now}
        if media != self.live.status.get("media"):
            self.live.set_status(media=media)

    # -- commands --------------------------------------------------------------
    async def press(self, action):
        """Run a dashboard button. Returns False when this computer can't do it."""
        if not self.available or action not in ACTIONS:
            return False
        if action in ("volup", "voldown"):
            vol = await self.volume()
            if vol is None:
                return False
            vol = max(0, min(100, vol + (VOLUME_STEP if action == "volup" else -VOLUME_STEP)))
            await self._osa(VOLUME_SET.format(v=vol))
        else:
            now = self.live.status["media"].get("now")
            # Spotify / Music when it plays, or it is the one we just paused (or keys aren't
            # allowed): told directly, no key permission needed
            if now and now["app"] in APPS and (now["playing"] or now["app"] == self.last_app or not self.keys):
                self.last_app = now["app"]
                await self._osa(f'tell application "{now["app"]}" to {APP_COMMAND[action]}')
            else:
                # YouTube Music in a browser, or whatever played last
                self.last_app = None
                await self.run("osascript", "-l", "JavaScript", "-e", MEDIA_KEY_JXA, str(KEYCODE[action]))
        await asyncio.sleep(0.4)                # let the player change before reading it back
        await self.refresh()
        return True


class DemoMedia:
    """--demo and tests on any system: a pretend player with a short playlist."""

    SONGS = [("Into the Climb", "The Gradients"), ("Cadence", "Zone Two"), ("Last Interval", "Threshold")]

    def __init__(self, live):
        self.live = live
        self.i, self.playing, self.vol = 0, True, 50
        self._publish(initial=True)

    def start(self):
        pass

    async def close(self):
        pass

    def _publish(self, initial=False):
        title, artist = self.SONGS[self.i]
        media = {"available": True, "keys": True, "volume": self.vol,
                 "now": {"app": "Spotify", "title": title, "artist": artist, "playing": self.playing}}
        if initial:
            self.live.status["media"] = media
        else:
            self.live.set_status(media=media)

    async def press(self, action):
        if action not in ACTIONS:
            return False
        if action == "playpause":
            self.playing = not self.playing
        elif action in ("next", "previous"):
            self.i = (self.i + (1 if action == "next" else -1)) % len(self.SONGS)
            self.playing = True
        else:
            self.vol = max(0, min(100, self.vol + (VOLUME_STEP if action == "volup" else -VOLUME_STEP)))
        self._publish()
        return True
