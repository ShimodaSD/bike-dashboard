"""Self-check for the parts that must not silently break: packet decoding and the .FIT file.
Run: uv run pytest"""
import asyncio
import os
import struct
import tempfile
import types
import unittest
from unittest import mock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logger"))
import thinkrider_logger as tl  # noqa: E402


class LoggerTest(unittest.TestCase):
    def test_indoor_bike_data(self):
        # flags: cadence (0x04) + power (0x40); speed present (bit0 clear)
        pkt = struct.pack("<HHHh", 0x0044, 3250, 180, 215)
        self.assertEqual(tl.decode_indoor_bike_data(pkt),
                         {"speed_kmh": 32.5, "cadence_rpm": 90.0, "power_w": 215})

    def test_fit_file_is_valid(self):
        hist = [{"timestamp_utc": f"2026-01-01T10:00:{i:02d}+00:00", "power_w": 200,
                 "cadence_rpm": 90, "speed_kmh": 30.0, "heart_rate_bpm": 140,
                 "distance_m": i * 8.3} for i in range(40)]
        data = tl.build_fit(hist, [0, 20])
        self.assertEqual(data[8:12], b".FIT")
        size = struct.unpack_from("<I", data, 4)[0]
        self.assertEqual(len(data), 14 + size + 2)
        self.assertEqual(tl.fit_crc(data[:12]), struct.unpack_from("<H", data, 12)[0])
        self.assertEqual(tl.fit_crc(data), 0)       # CRC over file + its CRC is 0


    def test_resume_after_finish(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = tl.Live(tmp)
            live.status["connected"] = True
            live.update({"power_w": 200, "cadence_rpm": 90, "speed_kmh": 30.0})
            self.assertFalse(live.resume_ride())                 # nothing to resume yet
            live.start_ride()
            for _ in range(5):
                live.tick()
            fit = live.finish_ride()
            self.assertTrue(fit and os.path.exists(fit))
            self.assertTrue(live.resume_ride())
            self.assertTrue(live.recording)
            for _ in range(3):
                live.tick()
            self.assertEqual(live.finish_ride(), fit)            # same file, written again
            self.assertEqual([s["t"] for s in live.history], list(range(8)))
            with open(os.path.join(tmp, "session_1hz.csv")) as f:
                self.assertEqual(len(f.read().strip().splitlines()), 9)   # header + 8 rows
            live.clear()
            self.assertFalse(live.resume_ride())                 # cleared: nothing to resume


class FakeDev:
    def __init__(self, address, name):
        self.address, self.name = address, name


class FakeAdv:
    def __init__(self, name, uuids, rssi=-60):
        self.local_name, self.service_uuids, self.rssi = name, uuids, rssi


NEARBY = {
    "T1": (FakeDev("T1", "THINK X2MAX"), FakeAdv("THINK X2MAX", [tl.u16(0x1826)])),
    "W1": (FakeDev("W1", "Forerunner 165"), FakeAdv("Forerunner 165", [tl.u16(0x180D)])),
    "W2": (FakeDev("W2", "HRM-Dual"), FakeAdv("HRM-Dual", [tl.u16(0x180D)], -80)),
}


class FakeScanner:
    @staticmethod
    async def discover(timeout, return_adv):
        return dict(NEARBY)

    @staticmethod
    async def find_device_by_filter(match, timeout):
        return next((d for d, a in NEARBY.values() if match(d, a)), None)


class FakeClient:
    connected = []

    def __init__(self, dev, disconnected_callback=None):
        self.dev, self.services = dev, []

    async def connect(self):
        FakeClient.connected.append(self.dev.address)

    async def disconnect(self):
        FakeClient.connected.remove(self.dev.address)

    async def start_notify(self, ch, fn):
        pass


class DevicePickerTest(unittest.TestCase):
    """Device panel: pick, switch, turn off, and remember across restarts (fake Bluetooth)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        patches = [mock.patch.object(tl, "BleakScanner", FakeScanner),
                   mock.patch.object(tl, "BleakClient", FakeClient),
                   mock.patch.object(tl, "DEVICES_FILE", os.path.join(self.tmp, "devices.json")),
                   mock.patch.object(tl, "dump_gatt", mock.AsyncMock())]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        FakeClient.connected = []

    def run_logger(self, steps, **kw):
        args = types.SimpleNamespace(address=None, name=None, no_hr=False, hr_address=None,
                                     hr_name=None, scan_time=1, out=self.tmp, **kw)

        async def go():
            tl.BLE_LOCK = asyncio.Lock()
            live = tl.Live(self.tmp)
            devs = tl.Devices(live, args)
            w = mock.Mock()
            devs.runners = {"trainer": lambda: tl.trainer_loop(args, live, devs, w, w, 0),
                            "hr": lambda: tl.hr_loop(args, live, devs, w, w, 0)}
            for r in tl.ROLES:
                devs.start(r)
            await asyncio.sleep(0.05)
            out = await steps(live, devs)
            await devs.close()
            return out
        return asyncio.run(go())

    def test_pick_switch_off_and_remember(self):
        async def first_run(live, devs):
            self.assertEqual(live.status["device"], "THINK X2MAX")          # auto-found trainer
            self.assertEqual(live.status["hr"]["device"], "Forerunner 165")  # Garmin preferred
            await devs.set("hr", {"mode": "device", "address": "W2", "name": "HRM-Dual"})
            await asyncio.sleep(0.05)
            self.assertEqual(sorted(FakeClient.connected), ["T1", "W2"])    # watch dropped
            await devs.set("trainer", {**devs.choice["trainer"], "mode": "off"})
            self.assertEqual(live.status["state"], "off")
            self.assertEqual(FakeClient.connected, ["W2"])
            devs.scan()
            await devs.scan_task
            self.assertEqual([d["kind"] for d in live.status["scan"]["found"]], ["trainer", "hr", "hr"])
        self.run_logger(first_run)

        async def second_run(live, devs):                                   # restart: same picks
            self.assertEqual(live.status["state"], "off")
            self.assertEqual(live.status["hr"]["device"], "HRM-Dual")
            self.assertEqual(FakeClient.connected, ["W2"])
        self.run_logger(second_run)

    def test_one_device_cannot_be_both(self):
        async def steps(live, devs):
            await devs.set("trainer", {"mode": "device", "address": "W1", "name": "Forerunner 165"})
            await asyncio.sleep(0.05)
            self.assertEqual(devs.choice["hr"]["mode"], "off")
        self.run_logger(steps)


if __name__ == "__main__":
    unittest.main()
