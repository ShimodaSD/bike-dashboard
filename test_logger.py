"""Self-check for the parts that must not silently break: packet decoding and the .FIT file.
Run: uv run python -m unittest test_logger"""
import struct
import unittest

import thinkrider_logger as tl


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


if __name__ == "__main__":
    unittest.main()
