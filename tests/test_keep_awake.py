"""Keep awake: on a Mac the logger holds a caffeinate assertion for as long as it runs."""
import os

from keep_awake import KeepAwake


class FakeProc:
    def __init__(self, argv, **_):
        self.argv, self.terminated = argv, False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0


def mac(**kw):
    started = []

    def popen(argv, **opts):
        started.append(FakeProc(argv, **opts))
        return started[-1]
    return KeepAwake(platform="darwin", which=lambda name: f"/usr/bin/{name}", popen=popen, **kw), started


def test_mac_runs_caffeinate_tied_to_the_logger():
    awake, started = mac()
    assert awake.start()
    assert started[0].argv == ["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())]
    assert not awake.start()                    # once
    awake.close()
    assert started[0].terminated and awake.proc is None


def test_other_systems_do_nothing():
    awake = KeepAwake(platform="linux", which=lambda name: "/usr/bin/x",
                      popen=lambda *a, **k: (_ for _ in ()).throw(AssertionError("no process")))
    assert not awake.available
    assert not awake.start()
    awake.close()


def test_missing_caffeinate_or_a_failed_start_is_harmless():
    assert not KeepAwake(platform="darwin", which=lambda name: None).start()

    def broken(*a, **k):
        raise OSError("no")
    awake = KeepAwake(platform="darwin", which=lambda name: "/usr/bin/caffeinate", popen=broken)
    assert not awake.start()
    awake.close()
