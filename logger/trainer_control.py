"""
trainer_control.py - make the trainer simulate a climb (or hold a power) over FTMS.

The logger is passive until the rider turns Trainer control on in the dashboard. Then it
uses the Fitness Machine Control Point (0x2AD9), the same standard control Zwift uses:

  Request Control (0x00) -> Start or Resume (0x07)
  Set Indoor Bike Simulation Parameters (0x11)   grade, for a climb       ("Climb" mode)
  Set Target Power (0x05)                        watts, ERG                ("ERG" mode)
  Reset (0x01)                                   gives control back when turned off

Each command is answered by an indication on the same characteristic:
0x80, the command's opcode, a result code (0x01 = success).

Safety:
  * off by default on every start (never remembered),
  * the grade goes back to 0 % (and ERG ends) on Finish, when the trainer disconnects
    and when the logger stops,
  * if another app takes over (status 0xFF "control permission lost", or result 0x05)
    control turns itself off and the dashboard says why.

A Tacx trainer whose firmware has no FTMS control point is driven with ANT+ FE-C pages over
its private Bluetooth service instead (fec.py): page 51 for the grade (with page 50 for wind
resistance) and page 49 for ERG. Those writes get no answer, so they count as done once written.

DemoControl gives the same behaviour without Bluetooth, for --demo.
"""

import asyncio
import json
import math
import os
import struct

import fec


def u16(x: int) -> str:
    return f"0000{x:04x}-0000-1000-8000-00805f9b34fb"


CONTROL_POINT = u16(0x2AD9)
FEATURE = u16(0x2ACC)
POWER_RANGE = u16(0x2AD8)

OP_REQUEST_CONTROL = 0x00
OP_RESET = 0x01
OP_TARGET_POWER = 0x05
OP_START = 0x07
OP_SIMULATION = 0x11
OP_RESPONSE = 0x80

NO_CONTROL_POINT = "This trainer has no FTMS or Tacx FE-C control, so it can't simulate climbs."

RESULTS = {0x01: "success", 0x02: "not supported", 0x03: "invalid value",
           0x04: "failed", 0x05: "control not permitted"}

GRADE_MIN, GRADE_MAX = -10.0, 20.0     # % (FTMS allows more; this is what a rider wants)
POWER_MIN, POWER_MAX = 50, 1000        # W (narrowed to the trainer's own range if it says)
SEND_GAP = 0.4                         # s between commands while a slider is dragged
REPLY_TIMEOUT = 3.0

# How hard a climb feels: the rider can change these on the dashboard (Settings > Climb feel).
# They are kept in config/trainer.json and apply at once, also mid-climb.
#   difficulty  % of the road grade the trainer is sent (like Zwift's trainer difficulty):
#               100 = the real grade, 50 = a 10 % climb feels like 5 %. Descents scale too.
#   crr         rolling resistance sent with every grade (0.004 = road tyres on asphalt)
#   cw          wind resistance coefficient in kg/m sent with every grade (0.51 = the value
#               Zwift and most FTMS apps send). The trainer turns it into air drag at speed.
# Whether the trainer uses crr and cw is up to its firmware; the grade always counts.
CRR = 0.004                            # sent in 0.0001 units -> 40
CW = 0.51                              # kg/m, sent in 0.01 units -> 51
DIFFICULTY = 100
SIM_DEFAULTS = {"difficulty": DIFFICULTY, "crr": CRR, "cw": CW}
SIM_LIMITS = {"difficulty": (0, 150), "crr": (0.001, 0.02), "cw": (0.1, 1.5)}
SIM_ROUND = {"difficulty": 0, "crr": 4, "cw": 2}       # decimals the trainer can take


# --------------------------------------------------------------------------
# Packets (pure functions, tested in tests/test_trainer_control.py)
# --------------------------------------------------------------------------
def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def cmd_request_control() -> bytes:
    return bytes([OP_REQUEST_CONTROL])


def cmd_start() -> bytes:
    return bytes([OP_START])


def cmd_reset() -> bytes:
    return bytes([OP_RESET])


def cmd_simulation(grade_pct: float, wind_ms: float = 0.0, crr: float = CRR, cw: float = CW) -> bytes:
    """Set Indoor Bike Simulation Parameters: wind sint16 (0.001 m/s), grade sint16 (0.01 %),
    crr uint8 (0.0001), cw uint8 (0.01 kg/m)."""
    return struct.pack("<BhhBB", OP_SIMULATION, round(wind_ms * 1000), round(grade_pct * 100),
                       clamp(round(crr * 10000), 0, 255), clamp(round(cw * 100), 0, 255))


def trainer_grade(grade_pct: float, difficulty: float) -> float:
    """The grade the trainer is sent for a road grade at this trainer difficulty (%)."""
    return round(grade_pct * difficulty / 100, 2)


def clean_sim(raw) -> dict:
    """Climb feel settings from a file or the dashboard: known keys, finite numbers, in range,
    rounded to what the trainer takes. Anything missing or broken falls back to the default."""
    out = dict(SIM_DEFAULTS)
    if isinstance(raw, dict):
        for k, (lo, hi) in SIM_LIMITS.items():
            v = raw.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
                out[k] = round(clamp(float(v), lo, hi), SIM_ROUND[k])
    out["difficulty"] = int(out["difficulty"])
    return out


def cmd_target_power(watts: float) -> bytes:
    return struct.pack("<Bh", OP_TARGET_POWER, round(watts))


def parse_response(data: bytes):
    """(request opcode, result code) for a control point indication, else None."""
    if len(data) >= 3 and data[0] == OP_RESPONSE:
        return data[1], data[2]
    return None


def parse_features(data: bytes) -> dict:
    """Fitness Machine Feature: 4 bytes machine features, 4 bytes target setting features."""
    if len(data) < 8:
        return {"sim": True, "erg": True}          # unknown: let the trainer answer
    targets = struct.unpack_from("<I", data, 4)[0]
    return {"erg": bool(targets & (1 << 3)), "sim": bool(targets & (1 << 13))}


# --------------------------------------------------------------------------
# Control state, shared by the real and the demo trainer
# --------------------------------------------------------------------------
class ControlBase:
    """What the dashboard sees under status["control"]:
    enabled   the rider's toggle
    state     off | connecting | on | lost | unsupported | error | waiting (no trainer)
    mode      sim (grade) | erg (target power)
    grade     % in sim mode (the road grade the rider picked), power_w in erg mode
    trainer_grade  the grade the trainer is sent: grade x difficulty
    sim       climb feel: {difficulty, crr, cw} (see SIM_DEFAULTS)
    msg       a sentence for the dashboard when something went wrong
    """

    def __init__(self, live, sim_file=None):
        self.live = live
        self.sim_file = sim_file                # None: climb feel isn't saved (tests, --demo)
        self.sim = clean_sim(_read_sim(sim_file))
        self.enabled = False
        self.state = "off"
        self.mode = "sim"
        self.grade = 0.0
        self.power_w = 150
        self.msg = None
        self.supports = {"sim": True, "erg": True}
        self.power_range = (POWER_MIN, POWER_MAX)
        self.connected = False
        self._publish()

    # -- what the dashboard reads ------------------------------------------
    def snapshot(self):
        return {"enabled": self.enabled, "state": self.state, "mode": self.mode,
                "grade": self.grade, "trainer_grade": self.trainer_grade(),
                "sim": dict(self.sim), "power_w": self.power_w, "msg": self.msg,
                "supports": self.supports, "power_range": list(self.power_range)}

    def _publish(self):
        self.live.status["control"] = self.snapshot()
        self.live.broadcast("status", self.live.status)

    def _set(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)
        self._publish()

    def trainer_grade(self):
        """The grade the trainer is (or would be) sent for the current road grade."""
        return trainer_grade(self.grade, self.sim["difficulty"])

    def sim_command(self, grade_pct=None):
        """Set Indoor Bike Simulation Parameters for the current grade with the climb feel."""
        g = self.trainer_grade() if grade_pct is None else trainer_grade(grade_pct, self.sim["difficulty"])
        return cmd_simulation(g, crr=self.sim["crr"], cw=self.sim["cw"])

    # -- the grade / power the ride should record --------------------------
    def current_grade(self):
        """Grade the trainer is simulating now (None when control is off or in ERG)."""
        if self.enabled and self.state == "on" and self.mode == "sim":
            return self.grade
        return None

    # -- dashboard actions ---------------------------------------------------
    def set_enabled(self, on: bool):
        if on == self.enabled:
            return
        self.enabled = on
        self.msg = None
        if on:
            self._turn_on()
        else:
            self._turn_off()

    def set_grade(self, pct: float):
        self._set(mode="sim", grade=round(clamp(pct, GRADE_MIN, GRADE_MAX) * 2) / 2)
        self._changed()

    def set_sim(self, **changes):
        """Change the climb feel (difficulty / crr / cw). Saved, and sent at once in Climb mode."""
        new = clean_sim({**self.sim, **changes})
        if new == self.sim:
            return
        self._set(sim=new)
        self._save_sim()
        if self.mode == "sim":
            self._changed()

    def _save_sim(self):
        if not self.sim_file:
            return
        try:
            os.makedirs(os.path.dirname(self.sim_file), exist_ok=True)
            with open(self.sim_file, "w") as fh:
                json.dump(self.sim, fh, indent=2)
        except OSError as e:
            print(f"Could not save {self.sim_file}: {e}")

    def set_power(self, watts: float):
        lo, hi = self.power_range
        self._set(mode="erg", power_w=int(round(clamp(watts, lo, hi) / 5) * 5))
        self._changed()

    def to_flat(self, why: str):
        """Finish / stop: back to 0 % in sim mode (ERG ends too)."""
        if self.mode == "sim" and self.grade == 0:
            return
        print(f"Trainer control: grade back to 0 % ({why})")
        self._set(mode="sim", grade=0.0)
        self._changed()

    # -- to implement ---------------------------------------------------------
    def _turn_on(self): ...
    def _turn_off(self): ...
    def _changed(self): ...


class TrainerControl(ControlBase):
    """FTMS control of a real trainer over Bluetooth (bleak client)."""

    def __init__(self, live, sim_file=None):
        super().__init__(live, sim_file)
        self.client = None
        self.cp = None
        self.fec = None                          # Tacx FE-C write characteristic, when no FTMS
        self._reply = None                       # Future for the command waiting for its answer
        self._lock = asyncio.Lock()              # one command at a time
        self._dirty = asyncio.Event()            # a new grade / power to send
        self._worker = None
        self._have_control = False

    # -- trainer connection (called from trainer_loop) ------------------------
    async def attach(self, client):
        """Trainer connected. Find the control point and what the trainer supports.
        Notifications for the control point must already be on (trainer_loop subscribes to all)."""
        self.client, self.cp, self.fec, self._have_control = client, None, None, False
        self.connected = True
        for svc in client.services:
            for ch in svc.characteristics:
                writable = {"write", "write-without-response"} & set(ch.properties)
                if ch.uuid.lower() == CONTROL_POINT and "write" in ch.properties:
                    self.cp = ch
                elif ch.uuid.lower() == fec.FEC_WRITE and writable:
                    self.fec = ch
        if self.fec and not self.cp:
            print("Trainer control: no FTMS control point, using Tacx FE-C over Bluetooth")
            self.supports = {"sim": True, "erg": True}
            if self.enabled:
                self.mode, self.grade = "sim", 0.0
                self._start_worker()
            else:
                self._set(state="off")
            return
        try:
            self.supports = parse_features(await client.read_gatt_char(FEATURE))
        except Exception:
            self.supports = {"sim": True, "erg": True}
        try:
            lo, hi, _step = struct.unpack_from("<hhH", await client.read_gatt_char(POWER_RANGE))
            if 0 <= lo < hi:
                self.power_range = (max(POWER_MIN, lo), min(POWER_MAX, hi))
        except Exception:
            pass
        if not self.cp:
            self._set(state="unsupported", enabled=False, msg=NO_CONTROL_POINT)
            return
        if self.enabled:                          # reconnected while on: take control again, at 0 %
            self.mode, self.grade = "sim", 0.0
            self._start_worker()
        else:
            self._set(state="off")

    def detach(self):
        """Trainer gone: control ends with it. The grade starts at 0 % when it comes back."""
        if not self.connected:
            return
        self.client = self.cp = self.fec = None
        self.connected = self._have_control = False
        if self._reply and not self._reply.done():
            self._reply.cancel()
        if self._worker:
            self._worker.cancel()
            self._worker = None
        self.mode, self.grade = "sim", 0.0
        self._set(state="waiting" if self.enabled else "off")

    def on_indication(self, data: bytes):
        """Every control point indication comes here (from the generic notify handler)."""
        r = parse_response(bytes(data))
        if r and self._reply and not self._reply.done():
            self._reply.set_result(r)

    def on_status(self, opcode: int):
        """Fitness Machine Status notification."""
        if opcode == 0xFF and self.enabled:
            self._lost("Another app took control of the trainer. Trainer control is off.")
        elif opcode == 0x03 and self.enabled:
            self._lost("The trainer stopped (safety key). Trainer control is off.")

    # -- internals ------------------------------------------------------------
    def _lost(self, msg):
        print(f"Trainer control: {msg}")
        self.enabled = self._have_control = False
        if self._worker:
            self._worker.cancel()
            self._worker = None
        self.mode, self.grade = "sim", 0.0
        self._set(state="lost", msg=msg)

    def _turn_on(self):
        if not self.connected:
            self._set(state="waiting")
            return
        if not self.cp and not self.fec:
            self._set(state="unsupported", enabled=False, msg=NO_CONTROL_POINT)
            return
        self._start_worker()

    def _start_worker(self):
        if not self._worker or self._worker.done():
            self._set(state="connecting")
            self._dirty.set()
            self._worker = asyncio.ensure_future(self._run())

    def _turn_off(self):
        if self._worker:
            self._worker.cancel()
            self._worker = None
        self.mode, self.grade = "sim", 0.0
        self._set(state="off")
        if self.connected and self._have_control:
            asyncio.ensure_future(self._release())

    def _changed(self):
        self._dirty.set()

    async def _send(self, payload: bytes):
        """Write one command and wait for its answer. Returns the result code."""
        if self.fec and not self.cp:             # FE-C: no answer, written is done
            async with self._lock:
                await self.client.write_gatt_char(self.fec, payload,
                                                  response="write" in self.fec.properties)
            return 0x01
        async with self._lock:
            loop = asyncio.get_running_loop()
            self._reply = loop.create_future()
            try:
                await self.client.write_gatt_char(self.cp, payload, response=True)
                op, result = await asyncio.wait_for(self._reply, REPLY_TIMEOUT)
            finally:
                self._reply = None
            if op != payload[0]:
                return 0x04
            return result

    async def _take_control(self):
        if self.fec and not self.cp:             # FE-C has no control handshake
            self._have_control = True
            return
        res = await self._send(cmd_request_control())
        if res != 0x01:
            raise ControlError(res)
        self._have_control = True
        await self._send(cmd_start())            # some trainers answer "not supported": fine

    async def _run(self):
        """Take control, then send the latest grade / power whenever it changes
        (at most every SEND_GAP s, so dragging the slider doesn't flood Bluetooth)."""
        try:
            await self._take_control()
            self._set(state="on")
            print("Trainer control on")
            while True:
                await self._dirty.wait()
                self._dirty.clear()
                await self._apply()
                await asyncio.sleep(SEND_GAP)
        except asyncio.CancelledError:
            raise
        except ControlError as e:
            if e.code == 0x05:
                self._lost("The trainer refused control. Close Zwift and the trainer’s own app (ThinkRider, Tacx Training) and try again.")
            else:
                self._fail(f"The trainer answered “{RESULTS.get(e.code, 'error')}”.")
        except asyncio.TimeoutError:
            self._fail("The trainer didn't answer the control request.")
        except Exception as e:                   # Bluetooth error: the trainer loop reconnects
            self._fail(f"Bluetooth error: {e}")

    async def _apply(self):
        if self.mode == "erg":
            if not self.supports.get("erg"):
                raise ControlError(0x02)
            res = await self._send(self._power_command())
        else:
            res = await self._sim(self.trainer_grade())
        if res == 0x05:                           # lost control: ask once more
            await self._take_control()
            res = await (self._send(self._power_command()) if self.mode == "erg"
                         else self._sim(self.trainer_grade()))
        if res != 0x01:
            raise ControlError(res)

    def _power_command(self):
        if self.fec and not self.cp:
            return fec.cmd_target_power(self.power_w)
        return cmd_target_power(self.power_w)

    async def _sim(self, grade):
        """Send a trainer grade with the climb feel. FE-C needs two pages: wind, then track."""
        if self.fec and not self.cp:
            await self._send(fec.cmd_wind(self.sim["cw"]))
            return await self._send(fec.cmd_track(grade, self.sim["crr"]))
        return await self._send(cmd_simulation(grade, crr=self.sim["crr"], cw=self.sim["cw"]))

    def _fail(self, msg):
        print(f"Trainer control: {msg}")
        self.enabled = False
        self._worker = None
        self._set(state="error", msg=msg)
        if self.connected and self._have_control:
            asyncio.ensure_future(self._release())

    async def _release(self):
        """Flat road, then give control back (Reset)."""
        try:
            await self._sim(0.0)
            if self.cp:
                await self._send(cmd_reset())
            print("Trainer control off (0 %, control released)")
        except Exception:
            pass
        self._have_control = False

    async def close(self):
        """Logger stopping: leave the trainer at 0 % with control released."""
        if self._worker:
            self._worker.cancel()
            self._worker = None
        if self.connected and self._have_control:
            try:
                await asyncio.wait_for(self._release(), 5)
            except Exception:
                pass


def _read_sim(path):
    if not path:
        return None
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


class ControlError(Exception):
    def __init__(self, code):
        super().__init__(RESULTS.get(code, f"result {code}"))
        self.code = code


class DemoControl(ControlBase):
    """--demo: no Bluetooth. Turning it on succeeds after a short delay; the demo ride
    reads current_grade() / mode to change its speed and power."""

    def __init__(self, live, sim_file=None):
        super().__init__(live, sim_file)
        self._task = None

    def attach(self):
        self.connected = True
        if self.enabled:
            self._turn_on()

    def detach(self):
        if not self.connected:
            return
        self.connected = False
        self.mode, self.grade = "sim", 0.0
        self._set(state="waiting" if self.enabled else "off")

    def _turn_on(self):
        if not self.connected:
            self._set(state="waiting")
            return
        self._set(state="connecting")

        async def ready():
            await asyncio.sleep(0.6)
            if self.enabled:
                self._set(state="on")
        self._task = asyncio.ensure_future(ready())

    def _turn_off(self):
        self.mode, self.grade = "sim", 0.0
        self._set(state="off")

    def lose(self, msg="Another app took control of the trainer. Trainer control is off."):
        """For tests: what happens when Zwift grabs the trainer."""
        self.enabled = False
        self.mode, self.grade = "sim", 0.0
        self._set(state="lost", msg=msg)

    async def close(self):
        pass
