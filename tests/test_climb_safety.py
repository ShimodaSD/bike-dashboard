"""Trainer control safety: limits, refusals, timeouts and handing control back."""
import asyncio
import struct

import pytest

import thinkrider_logger as tl
import trainer_control as tc


class Ch:
    def __init__(self, uuid, props):
        self.uuid, self.properties = uuid, props


class Svc:
    def __init__(self, chars):
        self.characteristics = chars


class Trainer:
    """Fake FTMS trainer. answer(opcode) -> result code, or None to stay silent."""

    def __init__(self, ctl, answer=lambda op: 0x01, features=(1 << 13) | (1 << 3),
                 power_range=(0, 1500), control_point=True):
        self.ctl, self.answer, self.writes = ctl, answer, []
        self.features, self.power_range = features, power_range
        self.services = [Svc([Ch(tc.CONTROL_POINT, ["write", "indicate"])] if control_point else [])]

    async def read_gatt_char(self, uuid):
        if uuid == tc.FEATURE:
            return struct.pack("<II", 0, self.features)
        if self.power_range is None:
            raise OSError("not readable")
        return struct.pack("<hhH", *self.power_range, 1)

    async def write_gatt_char(self, ch, data, response=True):
        self.writes.append(bytes(data))
        res = self.answer(data[0])
        if res is not None:
            asyncio.get_running_loop().call_soon(self.ctl.on_indication, bytes([0x80, data[0], res]))


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(tc, "SEND_GAP", 0.005)
    monkeypatch.setattr(tc, "REPLY_TIMEOUT", 0.05)


def run(fn, tmp_path):
    async def go():
        live = tl.Live(str(tmp_path))
        live.control = tc.TrainerControl(live)
        return await fn(live, live.control)
    return asyncio.run(go())


async def settle(t=0.03):
    await asyncio.sleep(t)


def test_grade_is_limited_and_rounded(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl)
        await ctl.attach(bike)
        ctl.set_enabled(True)
        await settle()
        for asked, sent in ((35, 20.0), (-40, -10.0), (3.26, 3.5), (3.24, 3.0)):
            ctl.set_grade(asked)
            await settle()
            assert ctl.grade == sent
            assert bike.writes[-1] == tc.cmd_simulation(sent)
    run(steps, tmp_path)


def test_power_limited_to_trainer_range(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl, power_range=(80, 600))
        await ctl.attach(bike)
        assert ctl.power_range == (80, 600)
        assert live.status["control"]["power_range"] == [80, 600]
        ctl.set_enabled(True)
        ctl.set_power(2000)
        await settle()
        assert bike.writes[-1] == tc.cmd_target_power(600)
        ctl.set_power(10)
        await settle()
        assert bike.writes[-1] == tc.cmd_target_power(80)
    run(steps, tmp_path)


def test_unreadable_or_odd_power_range_keeps_defaults(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl, power_range=None))
        assert ctl.power_range == (tc.POWER_MIN, tc.POWER_MAX)
        ctl.detach()
        await ctl.attach(Trainer(ctl, power_range=(500, 100)))
        assert ctl.power_range == (tc.POWER_MIN, tc.POWER_MAX)
    run(steps, tmp_path)


def test_no_control_point_is_unsupported(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl, control_point=False))
        ctl.set_enabled(True)
        assert ctl.state == "unsupported" and not ctl.enabled
        assert "can't simulate" in live.status["control"]["msg"]
    run(steps, tmp_path)


def test_turning_on_without_trainer_waits(tmp_path):
    async def steps(live, ctl):
        ctl.set_enabled(True)
        assert ctl.state == "waiting"
        bike = Trainer(ctl)
        await ctl.attach(bike)
        await settle()
        assert ctl.state == "on" and bike.writes[:2] == [b"\x00", b"\x07"]
    run(steps, tmp_path)


def test_silent_trainer_times_out_into_error(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl, answer=lambda op: None))
        ctl.set_enabled(True)
        await settle(0.15)
        assert ctl.state == "error" and not ctl.enabled
        assert "didn't answer" in ctl.msg
    run(steps, tmp_path)


def test_erg_on_a_trainer_without_erg(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl, features=1 << 13))
        ctl.set_enabled(True)
        await settle()
        ctl.set_power(200)
        await settle()
        assert ctl.state == "error" and "not supported" in ctl.msg
        assert ctl.current_grade() is None
    run(steps, tmp_path)


def test_rejected_grade_turns_control_off_and_releases(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl, answer=lambda op: 0x03 if op == tc.OP_SIMULATION and len(bike.writes) == 3 else 0x01)
        await ctl.attach(bike)
        ctl.set_enabled(True)
        await settle()
        assert ctl.state == "error" and "invalid value" in ctl.msg
        assert bike.writes[-2:] == [tc.cmd_simulation(0), tc.cmd_reset()]
    run(steps, tmp_path)


def test_lost_control_mid_ride_asks_again_once(tmp_path):
    lost = {"n": 0}

    def answer(op):
        if op == tc.OP_SIMULATION and lost["n"] == 0 and op:
            lost["n"] += 1
            return 0x05
        return 0x01

    async def steps(live, ctl):
        bike = Trainer(ctl, answer=answer)
        await ctl.attach(bike)
        ctl.set_enabled(True)
        await settle()
        assert ctl.state == "on"
        assert [w[0] for w in bike.writes] == [0x00, 0x07, 0x11, 0x00, 0x07, 0x11]
    run(steps, tmp_path)


def test_safety_key_stops_control(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl))
        ctl.set_enabled(True)
        ctl.set_grade(12)
        await settle()
        ctl.on_status(0x03)
        assert (ctl.state, ctl.grade, ctl.enabled) == ("lost", 0, False)
        assert "safety key" in ctl.msg
    run(steps, tmp_path)


def test_status_ignored_while_off(tmp_path):
    async def steps(live, ctl):
        await ctl.attach(Trainer(ctl))
        ctl.on_status(0xFF)
        assert ctl.state == "off" and ctl.msg is None
    run(steps, tmp_path)


def test_logger_stop_leaves_trainer_flat_and_released(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl)
        await ctl.attach(bike)
        ctl.set_enabled(True)
        ctl.set_grade(7)
        await settle()
        await ctl.close()
        assert bike.writes[-2:] == [tc.cmd_simulation(0), tc.cmd_reset()]
    run(steps, tmp_path)


def test_close_when_never_on_writes_nothing(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl)
        await ctl.attach(bike)
        await ctl.close()
        assert bike.writes == []
    run(steps, tmp_path)


def test_finish_in_erg_ends_erg(tmp_path):
    async def steps(live, ctl):
        bike = Trainer(ctl)
        await ctl.attach(bike)
        ctl.set_enabled(True)
        ctl.set_power(250)
        await settle()
        live.finish_ride()
        await settle()
        assert ctl.mode == "sim" and bike.writes[-1] == tc.cmd_simulation(0)
    run(steps, tmp_path)


def test_wind_crr_and_cw_packing():
    pkt = tc.cmd_simulation(0, wind_ms=-2.5, crr=0.1, cw=9)          # crr / cw clamp to a byte
    assert struct.unpack("<BhhBB", pkt) == (0x11, -2500, 0, 255, 255)


def test_short_feature_answer_assumes_both():
    assert tc.parse_features(b"\x00") == {"sim": True, "erg": True}


class TestDemoControl:
    def test_on_climb_lose(self, tmp_path):
        async def steps():
            live = tl.Live(str(tmp_path))
            ctl = tc.DemoControl(live)
            ctl.set_enabled(True)
            assert ctl.state == "waiting"
            ctl.attach()
            await asyncio.sleep(0.7)
            assert ctl.state == "on"
            ctl.set_grade(5)
            assert ctl.current_grade() == 5
            ctl.lose()
            assert ctl.state == "lost" and ctl.current_grade() is None
            ctl.detach()
            assert ctl.state == "off"
        asyncio.run(steps())

    def test_turned_off_before_ready_stays_off(self, tmp_path):
        async def steps():
            live = tl.Live(str(tmp_path))
            ctl = tc.DemoControl(live)
            ctl.attach()
            ctl.set_enabled(True)
            ctl.set_enabled(False)
            await asyncio.sleep(0.7)
            assert ctl.state == "off"
        asyncio.run(steps())
