"""Picking the dashboard port: 8000 unless another program (e.g. a Docker container) has it."""
import socket

import pytest

import thinkrider_logger as tl


@pytest.fixture
def listener():
    """Listen on a free port on all interfaces, like a Docker container publishing a port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("0.0.0.0", 0))
        s.listen()
        yield s.getsockname()[1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_busy_port_is_detected(listener):
    assert tl.port_in_use("127.0.0.1", listener)


def test_free_port_is_free():
    assert not tl.port_in_use("127.0.0.1", free_port())


def test_default_port_moves_on_when_taken(listener, monkeypatch, capsys):
    monkeypatch.setattr(tl, "DEFAULT_PORT", listener)
    p = tl.pick_port("127.0.0.1")
    assert p != listener and listener < p < listener + 20
    assert "already in use" in capsys.readouterr().out


def test_default_port_kept_when_free(monkeypatch, capsys):
    port = free_port()
    monkeypatch.setattr(tl, "DEFAULT_PORT", port)
    assert tl.pick_port("127.0.0.1") == port
    assert capsys.readouterr().out == ""


def test_explicit_port_taken_is_an_error(listener):
    with pytest.raises(OSError, match=f"Port {listener} is already in use"):
        tl.pick_port("127.0.0.1", listener)


def test_explicit_free_port_is_used():
    port = free_port()
    assert tl.pick_port("127.0.0.1", port) == port
