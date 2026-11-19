"""Self-check for trainer control (climb simulation / ERG) with a fake FTMS trainer.
Run: uv run pytest"""
import asyncio
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logger"))
import thinkrider_logger as tl  # noqa: E402
import trainer_control as tc  # noqa: E402


class PacketTest(unittest.TestCase):
    def test_simulation_packet(self):
        # 6 % grade, no wind, crr 0.004, cw 0.51 kg/m
        self.assertEqual(tc.cmd_simulation(6), struct.pack("<BhhBB", 0x11, 0, 600, 40, 51))
        self.assertEqual(tc.cmd_simulation(-2.5)[3:5], struct.pack("<h", -250))

    def test_power_and_simple_commands(self):
        self.assertEqual(tc.cmd_target_power(210), bytes([0x05, 210, 0]))
        self.assertEqual(tc.cmd_request_control(), b"\x00")
        self.assertEqual(tc.cmd_start(), b"\x07")
        self.assertEqual(tc.cmd_reset(), b"\x01")

    def test_response_and_features(self):
        self.assertEqual(tc.parse_response(bytes([0x80, 0x11, 0x01])), (0x11, 0x01))
        self.assertIsNone(tc.parse_response(bytes([0x12, 0, 0])))
        feat = struct.pack("<II", 0, (1 << 13) | (1 << 3))
        self.assertEqual(tc.parse_features(feat), {"erg": True, "sim": True})
        self.assertEqual(tc.parse_features(struct.pack("<II", 0, 1 << 13)), {"erg": False, "sim": True})


class Ch:
    def __init__(self, uuid, props):
        self.uuid, self.properties = uuid, props


class Svc:
    def __init__(self, chars):
        self.characteristics = chars


class FakeTrainer:
    """Answers every control point write with an indication, like an FTMS trainer."""

    def __init__(self, ctl, refuse=False):
        self.ctl, self.refuse, self.writes = ctl, refuse, []
        self.services = [Svc([Ch(tc.CONTROL_POINT, ["write", "indicate"])])]

    async def read_gatt_char(self, uuid):
        if uuid == tc.FEATURE:
            return struct.pack("<II", 0, (1 << 13) | (1 << 3))
        return struct.pack("<hhH", 0, 1500, 1)

    async def write_gatt_char(self, ch, data, response=True):
        self.writes.append(bytes(data))
        result = 0x05 if self.refuse and data[0] == 0x00 else 0x01
        asyncio.get_running_loop().call_soon(self.ctl.on_indication, bytes([0x80, data[0], result]))


class ControlTest(unittest.TestCase):
    def run_async(self, fn):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                live = tl.Live(tmp)
                old = tc.SEND_GAP
                tc.SEND_GAP = 0.01
                try:
                    live.control = tc.TrainerControl(live)
                    return await fn(live, live.control)
                finally:
                    tc.SEND_GAP = old
        return asyncio.run(go())

    def test_off_by_default_then_climb_and_flat_on_finish(self):
        async def steps(live, ctl):
            bike = FakeTrainer(ctl)
            await ctl.attach(bike)
            self.assertEqual(live.status["control"]["state"], "off")
            self.assertEqual(bike.writes, [])                     # passive until turned on
            ctl.set_enabled(True)
            await asyncio.sleep(0.05)
            self.assertEqual(ctl.state, "on")
            self.assertEqual([w[0] for w in bike.writes[:3]], [0x00, 0x07, 0x11])
            ctl.set_grade(6.2)                                    # rounds to 0.5 %
            await asyncio.sleep(0.05)
            self.assertEqual(bike.writes[-1], tc.cmd_simulation(6.0))
            self.assertEqual(ctl.current_grade(), 6.0)
            ctl.set_power(212)                                    # ERG, rounds to 5 W
            await asyncio.sleep(0.05)
            self.assertEqual(bike.writes[-1], tc.cmd_target_power(210))
            self.assertIsNone(ctl.current_grade())
            live.start_ride()
            live.finish_ride()                                    # Finish: flat road again
            await asyncio.sleep(0.05)
            self.assertEqual(bike.writes[-1], tc.cmd_simulation(0))
            ctl.set_enabled(False)                                # off: 0 % then Reset
            await asyncio.sleep(0.05)
            self.assertEqual(bike.writes[-2:], [tc.cmd_simulation(0), tc.cmd_reset()])
            self.assertEqual(ctl.state, "off")
        self.run_async(steps)

    def test_permission_lost_turns_control_off(self):
        async def steps(live, ctl):
            bike = FakeTrainer(ctl)
            await ctl.attach(bike)
            ctl.set_enabled(True)
            ctl.set_grade(8)
            await asyncio.sleep(0.05)
            ctl.on_status(0xFF)                                   # Zwift took over
            self.assertFalse(ctl.enabled)
            self.assertEqual(ctl.state, "lost")
            self.assertEqual(ctl.grade, 0)
            self.assertIn("Another app", live.status["control"]["msg"])
        self.run_async(steps)

    def test_refused_control(self):
        async def steps(live, ctl):
            await ctl.attach(FakeTrainer(ctl, refuse=True))
            ctl.set_enabled(True)
            await asyncio.sleep(0.05)
            self.assertEqual(ctl.state, "lost")
            self.assertFalse(ctl.enabled)
        self.run_async(steps)

    def test_disconnect_drops_to_flat_and_reconnect_takes_control(self):
        async def steps(live, ctl):
            await ctl.attach(FakeTrainer(ctl))
            ctl.set_enabled(True)
            ctl.set_grade(10)
            await asyncio.sleep(0.05)
            ctl.detach()                                          # trainer dropped
            self.assertEqual((ctl.state, ctl.grade), ("waiting", 0))
            bike = FakeTrainer(ctl)
            await ctl.attach(bike)                                # came back
            await asyncio.sleep(0.05)
            self.assertEqual(ctl.state, "on")
            self.assertEqual(bike.writes[:3], [b"\x00", b"\x07", tc.cmd_simulation(0)])
        self.run_async(steps)

    def test_grade_is_recorded(self):
        async def steps(live, ctl):
            await ctl.attach(FakeTrainer(ctl))
            ctl.set_enabled(True)
            ctl.set_grade(4)
            await asyncio.sleep(0.05)
            live.status["connected"] = True
            live.start_ride()
            s = live.tick()
            self.assertEqual(s["grade_pct"], 4.0)
            live.finish_ride()
        self.run_async(steps)

    def test_demo_speed_drops_on_a_climb(self):
        flat, climb = tl.demo_speed(250, 0), tl.demo_speed(250, 8)
        self.assertGreater(flat, 30)
        self.assertLess(climb, 15)
        self.assertGreater(tl.demo_speed(0, -6), 20)              # coasting downhill


if __name__ == "__main__":
    unittest.main()
