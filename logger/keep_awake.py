"""Keeps the Mac from going to sleep while the logger runs, so a ride keeps recording (Bluetooth,
the .FIT, the dashboard feed) even if nobody touches the keyboard for a while.

On macOS it runs `caffeinate -i -w <logger pid>`: no idle system sleep until the logger ends, even
if it crashes (-w). The display may still dim; the dashboard page keeps the screen on itself while
it is open (Screen Wake Lock, dashboard/src/hooks/wake-lock.ts). Closing the lid still sleeps.
Other systems: nothing happens. --allow-sleep turns it off.
"""
import os
import shutil
import subprocess
import sys


class KeepAwake:
    """`popen` and `which` are swapped in tests."""

    def __init__(self, platform=sys.platform, which=shutil.which, popen=subprocess.Popen):
        self.tool = which("caffeinate") if platform == "darwin" else None
        self.popen = popen
        self.proc = None

    @property
    def available(self):
        return self.tool is not None

    def start(self):
        if not self.tool or self.proc:
            return False
        try:
            self.proc = self.popen([self.tool, "-i", "-w", str(os.getpid())],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            self.proc = None
        return self.proc is not None

    def close(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
