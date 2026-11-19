"""Bluetooth packet decoders: FTMS Indoor Bike Data, Cycling Power, CSC, Heart Rate, FTMS status."""
import struct

import pytest

import thinkrider_logger as tl


@pytest.fixture(autouse=True)
def fresh_cadence_counters():
    for calc in (tl.cps_crank, tl.cps_wheel, tl.csc_crank, tl.csc_wheel):
        calc.prev = None
    yield


class TestIndoorBikeData:
    def test_more_data_bit_means_no_speed(self):
        pkt = struct.pack("<Hh", 0x0041, 180)               # More Data + power
        assert tl.decode_indoor_bike_data(pkt) == {"power_w": 180}

    def test_every_field(self):
        flags = 0x1FFE                                      # all optional fields, speed present
        pkt = struct.pack("<H", flags)
        pkt += struct.pack("<HHHH", 3012, 2950, 182, 170)   # speed, avg speed, cadence, avg cadence
        pkt += (12345).to_bytes(3, "little")                # distance (uint24)
        pkt += struct.pack("<hhh", -3, 250, 230)            # resistance, power, avg power
        pkt += struct.pack("<HHB", 321, 600, 10)            # energy total / h / min
        pkt += struct.pack("<BB", 142, 87)                  # HR, MET x10
        pkt += struct.pack("<HH", 900, 2700)                # elapsed, remaining
        assert tl.decode_indoor_bike_data(pkt) == {
            "speed_kmh": 30.12, "avg_speed_kmh": 29.5, "cadence_rpm": 91.0, "avg_cadence_rpm": 85.0,
            "total_distance_m": 12345, "resistance_level": -3, "power_w": 250, "avg_power_w": 230,
            "total_energy_kcal": 321, "energy_per_hour_kcal": 600, "energy_per_min_kcal": 10,
            "heart_rate_bpm": 142, "met": 8.7, "elapsed_time_s": 900, "remaining_time_s": 2700,
        }

    def test_negative_power_is_kept_signed(self):
        pkt = struct.pack("<Hh", 0x0041, -12)
        assert tl.decode_indoor_bike_data(pkt)["power_w"] == -12

    @pytest.mark.parametrize("pkt", [b"", b"\x44", struct.pack("<HH", 0x0044, 3000)])
    def test_short_packet_raises(self, pkt):
        with pytest.raises(ValueError, match="too short"):
            tl.decode_indoor_bike_data(pkt)


class TestCyclingPower:
    def test_power_only(self):
        assert tl.decode_cycling_power(struct.pack("<Hh", 0, 233)) == {"power_w": 233}

    def test_crank_cadence_from_two_packets(self):
        p1 = struct.pack("<HhHH", 0x20, 200, 100, 0)
        p2 = struct.pack("<HhHH", 0x20, 210, 101, 683)      # 1 rev in 683/1024 s = 90 rpm
        assert "cadence_rpm" not in tl.decode_cycling_power(p1)
        out = tl.decode_cycling_power(p2)
        assert out["cadence_rpm"] == pytest.approx(90.0, abs=0.1)
        assert out["crank_revs"] == 101

    def test_crank_counters_wrap_around(self):
        tl.decode_cycling_power(struct.pack("<HhHH", 0x20, 200, 65535, 65000))
        out = tl.decode_cycling_power(struct.pack("<HhHH", 0x20, 200, 0, (65000 + 683) % 65536))
        assert out["cadence_rpm"] == pytest.approx(90.0, abs=0.1)

    def test_same_event_time_gives_no_cadence(self):
        pkt = struct.pack("<HhHH", 0x20, 200, 100, 500)
        tl.decode_cycling_power(pkt)
        assert "cadence_rpm" not in tl.decode_cycling_power(pkt)   # repeat: no new crank event

    def test_wheel_and_extras(self):
        pkt = struct.pack("<Hh", 0x0815, 300)               # balance, torque, wheel, energy
        pkt += struct.pack("<BH", 100, 64)                  # 50 %, 2 Nm
        pkt += struct.pack("<IH", 1000, 2048)
        pkt += struct.pack("<H", 12)
        out = tl.decode_cycling_power(pkt)
        assert out["pedal_balance_pct"] == 50
        assert out["accumulated_torque_nm"] == 2
        assert out["wheel_revs"] == 1000
        assert out["accumulated_energy_kj"] == 12


class TestCscAndHeartRate:
    def test_csc_wheel_and_crank(self):
        tl.decode_csc(struct.pack("<BIHHH", 0x03, 10, 0, 50, 0))
        out = tl.decode_csc(struct.pack("<BIHHH", 0x03, 12, 1024, 51, 640))
        assert out["wheel_rpm"] == 120.0                    # 2 revs in 1 s
        assert out["cadence_rpm"] == 96.0                   # 1 rev in 0.625 s

    def test_hr_8_and_16_bit(self):
        assert tl.decode_hr(bytes([0x00, 72])) == {"heart_rate_bpm": 72}
        assert tl.decode_hr(bytes([0x01]) + struct.pack("<H", 301)) == {"heart_rate_bpm": 301}

    def test_hr_with_rr_intervals_ignores_them(self):
        assert tl.decode_hr(bytes([0x10, 130, 0x00, 0x04])) == {"heart_rate_bpm": 130}


class TestFtmsStatus:
    def test_simulation_params_changed(self):
        pkt = bytes([0x12]) + struct.pack("<hhBB", -500, 650, 40, 51)
        assert tl.decode_ftms_status(pkt) == {
            "status_opcode": 0x12, "status": "indoor bike simulation params changed",
            "wind_speed_ms": -0.5, "grade_pct": 6.5, "crr": 0.004, "cw_kg_m": 0.51}

    def test_target_power_and_permission_lost(self):
        assert tl.decode_ftms_status(bytes([0x08]) + struct.pack("<h", 220))["target_power_w"] == 220
        assert tl.decode_ftms_status(b"\xff")["status"] == "control permission lost"
        assert tl.decode_ftms_status(b"\x42")["status"] == "unknown"

    def test_supported_range(self):
        assert tl.decode_supported_range(struct.pack("<hhH", 0, 1500, 1), 1) == {"min": 0, "max": 1500, "step": 1}


def test_device_kind():
    assert tl.device_kind("THINK X2MAX", []) == "trainer"
    assert tl.device_kind(None, [tl.u16(0x1826).upper()]) == "trainer"
    assert tl.device_kind("Forerunner 165", []) == "hr"
    assert tl.device_kind("HRM-Pro", [tl.u16(0x180D)]) == "hr"
    assert tl.device_kind("Speaker", []) == "other"
