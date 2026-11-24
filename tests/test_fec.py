"""Tacx FE-C over Bluetooth: frames, data pages and trainer control without FTMS.
Run: uv run pytest"""
import asyncio
import struct
import tempfile
import unittest

import fec
import thinkrider_logger as tl
import trainer_control as tc
from test_trainer_control import Ch, Svc


def page(*b):
    return bytes(b)


class FrameTest(unittest.TestCase):
    def test_frame_has_header_and_xor_checksum(self):
        msg = fec.frame(page(0x33, 0xFF, 0xFF, 0xFF, 0xFF, 0x20, 0x4E, 0x50))
        self.assertEqual(msg[:4], bytes([0xA4, 0x09, 0x4E, 0x05]))
        x = 0
        for b in msg[:-1]:
            x ^= b
        self.assertEqual(msg[-1], x)
        self.assertEqual(fec.unframe(msg), msg[4:12])

    def test_bad_frames_are_ignored(self):
        msg = bytearray(fec.frame(page(0x10, 25, 0, 0, 0x10, 0x27, 0xFF, 0x30)))
        msg[-1] ^= 1                                          # wrong checksum
        self.assertIsNone(fec.unframe(bytes(msg)))
        self.assertIsNone(fec.unframe(b"\xa4\x09"))
        self.assertEqual(fec.decode(b"\x01\x02"), {})


class CommandTest(unittest.TestCase):
    def test_track_resistance(self):
        p = fec.unframe(fec.cmd_track(5.0, 0.004))
        self.assertEqual(p[0], 0x33)
        self.assertEqual(struct.unpack_from("<H", p, 5)[0], 20500)  # (5 + 200) / 0.01
        self.assertEqual(p[7], 80)                                  # 0.004 / 5e-5
        self.assertEqual(struct.unpack_from("<H", fec.unframe(fec.cmd_track(-3))[5:7])[0], 19700)

    def test_wind_and_target_power(self):
        self.assertEqual(fec.unframe(fec.cmd_wind(0.51))[5:8], bytes([51, 127, 100]))
        p = fec.unframe(fec.cmd_target_power(210))
        self.assertEqual((p[0], struct.unpack_from("<H", p, 6)[0]), (0x31, 840))


class DecodeTest(unittest.TestCase):
    def test_general_page_speed(self):
        # 10.000 m/s = 36 km/h, no heart rate
        d = fec.decode(fec.frame(page(0x10, 25, 0, 0, 0x10, 0x27, 0xFF, 0x30)))
        self.assertEqual(d["speed_kmh"], 36.0)
        self.assertNotIn("heart_rate_bpm", d)

    def test_trainer_page_cadence_and_12_bit_power(self):
        # cadence 88 rpm, power 0x123 = 291 W, trainer status in the high nibble
        d = fec.decode(fec.frame(page(0x19, 7, 88, 0, 0, 0x23, 0x31, 0x30)))
        self.assertEqual((d["cadence_rpm"], d["power_w"]), (88, 291))

    def test_logger_knows_the_tacx_service(self):
        self.assertIs(tl.DECODERS[fec.FEC_NOTIFY], fec.decode)
        self.assertEqual(tl.device_kind("", [fec.FEC_SVC]), "trainer")


class FakeTacx:
    """A Tacx with FE-C over Bluetooth and no FTMS control point (older firmware)."""

    def __init__(self):
        self.writes = []
        self.services = [Svc([Ch(fec.FEC_NOTIFY, ["notify"]),
                              Ch(fec.FEC_WRITE, ["write-without-response", "write"])])]

    async def read_gatt_char(self, uuid):
        raise OSError("no such characteristic")

    async def write_gatt_char(self, ch, data, response=True):
        self.writes.append(bytes(data))


class FecControlTest(unittest.TestCase):
    def test_climb_erg_and_off_over_fec(self):
        async def go():
            with tempfile.TemporaryDirectory() as tmp:
                live = tl.Live(tmp)
                old, tc.SEND_GAP = tc.SEND_GAP, 0.01
                try:
                    ctl = live.control = tc.TrainerControl(live)
                    bike = FakeTacx()
                    await ctl.attach(bike)
                    self.assertEqual(ctl.state, "off")
                    self.assertEqual(bike.writes, [])                 # passive until turned on
                    ctl.set_enabled(True)
                    ctl.set_grade(6)
                    await asyncio.sleep(0.05)
                    self.assertEqual(ctl.state, "on")
                    self.assertEqual(bike.writes[-2:], [fec.cmd_wind(0.51), fec.cmd_track(6.0, 0.004)])
                    ctl.set_power(200)
                    await asyncio.sleep(0.05)
                    self.assertEqual(bike.writes[-1], fec.cmd_target_power(200))
                    ctl.set_enabled(False)                            # off: flat road, no FTMS reset
                    await asyncio.sleep(0.05)
                    self.assertEqual(bike.writes[-1], fec.cmd_track(0.0, 0.004))
                    self.assertEqual(ctl.state, "off")
                finally:
                    tc.SEND_GAP = old
        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
