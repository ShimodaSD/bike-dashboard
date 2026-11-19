"""Run the logger's web server on a free port and talk raw HTTP to it."""
import asyncio
import contextlib

import thinkrider_logger as tl


@contextlib.asynccontextmanager
async def serve(live):
    server = await asyncio.start_server(lambda r, w: tl.handle_http(r, w, live), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield port
    finally:
        server.close()          # open /events streams end with the event loop (no wait_closed)


async def request(port, method, path, headers=None):
    """(status code, headers dict, body bytes)."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    hdrs = {"Host": f"127.0.0.1:{port}", **(headers or {})}
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items() if v is not None)
    writer.write((head + "\r\n").encode())
    await writer.drain()
    raw = await reader.read()
    writer.close()
    top, _, body = raw.partition(b"\r\n\r\n")
    lines = top.decode().split("\r\n")
    code = int(lines[0].split()[1])
    out = {}
    for line in lines[1:]:
        k, _, v = line.partition(":")
        out[k.strip().lower()] = v.strip()
    return code, out, body


async def open_events(port, query=""):
    """Open /events and return (reader, writer) after the response headers."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET /events{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
    await writer.drain()
    while (await reader.readline()) not in (b"\r\n", b""):
        pass
    return reader, writer


async def next_event(reader, timeout=2):
    name, data = None, None
    while True:
        line = (await asyncio.wait_for(reader.readline(), timeout)).decode().rstrip("\n")
        if line.startswith("event: "):
            name = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
        elif line == "" and name:
            return name, data
