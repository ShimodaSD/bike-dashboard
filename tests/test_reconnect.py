"""Bluetooth drops: the trainer and heart-rate loops reconnect by themselves, the ride timer
pauses meanwhile, stale cadence counters are reset and trainer control goes back to flat."""
import asyncio
import struct
import types
from unittest import mock

import pytest

import thinkrider_logger as tl
import trainer_control as tc

REAL_SLEEP = asyncio.sleep


async def fast_sleep(delay, *a, **kw):        # reconnect back-offs (2-5 s) in a few ms
    await REAL_SLEEP(min(delay, 0.005), *a, **kw)


class Dev:
    def __init__(self, address, name):
        self.address, self.name = address, name


class Adv:
    def __init__(self, name, uuids, rssi=-60):
        self.local_name, self.service_uuids, self.rssi = name, uuids, rssi


class Ch:
    def __init__(self, uuid, props, handle=1):
        self.uuid, self.properties, self.handle, self.descriptors = uuid, props, handle, []


class Svc:
    def __init__(self, uuid, chars):
        self.uuid, self.characteristics = uuid, chars


TRAINER_SVCS = [Svc(tl.u16(0x1826), [Ch(tl.u16(0x2AD2), ["notify"]), Ch(tc.CONTROL_POINT, ["write", "indicate"]),
                                     Ch(tl.u16(0x2ADA), ["notify"])]),
                Svc(tl.u16(0x1818), [Ch(tl.u16(0x2A63), ["notify"])])]


class Air:
    """What is in Bluetooth range, and every client the loops create."""

    def __init__(self):
        self.nearby = {
            "T1": (Dev("T1", "THINK X2MAX"), Adv("THINK X2MAX", [tl.u16(0x1826)])),
            "W1": (Dev("W1", "Forerunner 165"), Adv("Forerunner 165", [tl.u16(0x180D)])),
        }
        self.clients = []
        self.fail_connects = 0

    def scanner(self):
        air = self

        class Scanner:
            @staticmethod
            async def discover(timeout, return_adv):
                return dict(air.nearby)

            @staticmethod
            async def find_device_by_filter(match, timeout):
                return next((d for d, a in air.nearby.values() if match(d, a)), None)
        return Scanner

    def client_class(self):
        air = self

        class Client:
            def __init__(self, dev, disconnected_callback=None):
                self.dev, self.on_gone = dev, disconnected_callback
                self.services = TRAINER_SVCS if dev.address.startswith("T") else []
                self.handlers, self.writes, self.connected = {}, [], False
                air.clients.append(self)

            async def connect(self):
                if air.fail_connects:
                    air.fail_connects -= 1
                    raise OSError("Bluetooth is busy")
                self.connected = True

            async def disconnect(self):
                self.connected = False

            async def start_notify(self, ch, fn):
                self.handlers[getattr(ch, "uuid", ch)] = fn

            async def read_gatt_char(self, uuid):
                return struct.pack("<II", 0, (1 << 13) | (1 << 3)) if uuid == tc.FEATURE else struct.pack("<hhH", 0, 1500, 1)

            async def write_gatt_char(self, ch, data, response=True):
                self.writes.append(bytes(data))
                fn = self.handlers[tc.CONTROL_POINT]
                asyncio.get_running_loop().call_soon(fn, None, bytearray([0x80, data[0], 0x01]))

            def drop(self):                                 # walked out of range / powered off
                self.connected = False
                self.on_gone(self)

            def send(self, uuid, data):
                self.handlers[uuid](None, bytearray(data))
        return Client

    def live_clients(self, prefix):
        return [c for c in self.clients if c.connected and c.dev.address.startswith(prefix)]


@pytest.fixture
def env(tmp_path, monkeypatch):
    air = Air()
    monkeypatch.setattr(tl, "BleakScanner", air.scanner())
    monkeypatch.setattr(tl, "BleakClient", air.client_class())
    monkeypatch.setattr(tl, "DEVICES_FILE", str(tmp_path / "devices.json"))
    monkeypatch.setattr(tl, "dump_gatt", mock.AsyncMock())
    monkeypatch.setattr(tl.asyncio, "sleep", fast_sleep)
    monkeypatch.setattr(tc, "SEND_GAP", 0.001)
    return types.SimpleNamespace(air=air, tmp=str(tmp_path))


def run(env, steps, control=False):
    args = types.SimpleNamespace(address=None, name=None, no_hr=False, hr_address=None, hr_name=None,
                                 scan_time=1, out=env.tmp)

    async def go():
        tl.BLE_LOCK = asyncio.Lock()
        live = tl.Live(env.tmp)
        if control:
            live.control = tc.TrainerControl(live)
        devs = tl.Devices(live, args)
        w = mock.Mock()
        devs.runners = {"trainer": lambda: tl.trainer_loop(args, live, devs, w, w, 0),
                        "hr": lambda: tl.hr_loop(args, live, devs, w, w, 0)}
        for r in tl.ROLES:
            devs.start(r)
        try:
            return await steps(live, devs)
        finally:
            await devs.close()
    return asyncio.run(go())


async def until(cond, timeout=1.0):
    for _ in range(int(timeout / 0.005)):
        if cond():
            return
        await REAL_SLEEP(0.005)
    raise AssertionError("condition not reached")


def test_trainer_drop_pauses_ride_and_reconnects(env):
    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        live.start_ride()
        live.tick()
        (first,) = env.air.live_clients("T")
        first.drop()
        await until(lambda: not live.status["connected"])
        assert live.status["state"] in ("reconnecting", "searching")
        live.tick()                                         # paused: no sample
        assert len(live.history) == 1
        await until(lambda: live.status["state"] == "connected")
        (second,) = env.air.live_clients("T")
        assert second is not first
        live.tick()
        assert len(live.history) == 2
        live.finish_ride()
    run(env, steps)


def test_connect_errors_are_retried(env):
    env.air.fail_connects = 2

    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        assert live.status["device"] == "THINK X2MAX"
    run(env, steps)


def test_trainer_out_of_range_keeps_searching(env):
    del env.air.nearby["T1"]

    async def steps(live, devs):
        await until(lambda: live.status["state"] == "searching")
        await REAL_SLEEP(0.03)
        assert not live.status["connected"]
        env.air.nearby["T1"] = (Dev("T1", "THINK X2MAX"), Adv("THINK X2MAX", [tl.u16(0x1826)]))
        await until(lambda: live.status["state"] == "connected")
    run(env, steps)


def test_cadence_counters_reset_on_reconnect(env):
    """Crank counters from before the drop would turn into a huge fake cadence."""
    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        (c,) = env.air.live_clients("T")
        c.send(tl.u16(0x2A63), struct.pack("<HhHH", 0x20, 200, 100, 0))
        c.drop()
        await until(lambda: live.status["state"] == "connected" and env.air.live_clients("T"))
        (c,) = env.air.live_clients("T")
        live.vals.pop("cadence_rpm", None)
        c.send(tl.u16(0x2A63), struct.pack("<HhHH", 0x20, 200, 5000, 100))
        assert "cadence_rpm" not in live.vals            # first packet after reconnect: no rpm
    run(env, steps)


def test_packets_update_the_live_numbers(env):
    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        (c,) = env.air.live_clients("T")
        c.send(tl.u16(0x2AD2), struct.pack("<HHHh", 0x0044, 3250, 180, 215))
        c.send(tl.u16(0x2AD2), b"\x44")                  # broken packet: logged, not fatal
        assert live.now()["power_w"] == 215 and live.packets == 2
    run(env, steps)


def test_hr_drop_reconnects_and_keeps_trainer(env):
    async def steps(live, devs):
        await until(lambda: live.status["hr"]["state"] == "connected")
        (w,) = env.air.live_clients("W")
        w.send(tl.u16(0x2A37), bytes([0, 128]))
        assert live.now()["heart_rate_bpm"] == 128
        w.drop()
        await until(lambda: live.status["hr"]["state"] != "connected")
        await until(lambda: live.status["hr"]["state"] == "connected")
        assert live.status["state"] == "connected"        # trainer untouched
        assert len(env.air.live_clients("W")) == 1
    run(env, steps)


def test_hr_never_takes_the_trainer(env):
    """A trainer that also broadcasts heart rate must not be grabbed a second time as the HR device."""
    env.air.nearby = {"T1": (Dev("T1", "THINK X2MAX"), Adv("THINK X2MAX", [tl.u16(0x1826), tl.u16(0x180D)]))}

    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        await REAL_SLEEP(0.03)
        assert live.status["hr"]["state"] != "connected"
        assert len(env.air.live_clients("T")) == 1
    run(env, steps)


def test_drop_mid_climb_goes_flat_and_takes_control_again(env):
    async def steps(live, devs):
        await until(lambda: live.status["state"] == "connected")
        live.control.set_enabled(True)
        live.control.set_grade(9)
        await until(lambda: live.control.state == "on")
        await until(lambda: env.air.live_clients("T")[0].writes[-1:] == [tc.cmd_simulation(9)])
        env.air.live_clients("T")[0].drop()
        await until(lambda: live.control.state == "waiting")
        assert live.control.grade == 0
        await until(lambda: live.control.state == "on")
        (c,) = env.air.live_clients("T")
        await until(lambda: len(c.writes) >= 3)
        assert c.writes[:3] == [tc.cmd_request_control(), tc.cmd_start(), tc.cmd_simulation(0)]
    run(env, steps, control=True)
