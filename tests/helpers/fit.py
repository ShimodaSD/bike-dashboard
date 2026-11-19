"""Read back the .FIT files the logger writes, so tests can check what Strava / Garmin will see.

Handles exactly what FitWriter produces: normal headers, definition + data messages, little
endian, no developer fields and no compressed timestamps."""
import struct

TYPES = {0x00: "B", 0x02: "B", 0x84: "H", 0x86: "I", 0x8C: "I"}
INVALID = {0x00: 0xFF, 0x02: 0xFF, 0x84: 0xFFFF, 0x86: 0xFFFFFFFF, 0x8C: 0}

FILE_ID, SESSION, LAP, RECORD, EVENT, ACTIVITY = 0, 18, 19, 20, 21, 34


def read_fit(data: bytes):
    """[(global message number, {field number: value or None}), ...] in file order."""
    hdr_len = data[0]
    size = struct.unpack_from("<I", data, 4)[0]
    assert data[8:12] == b".FIT"
    i, end = hdr_len, hdr_len + size
    defs, out = {}, []
    while i < end:
        h = data[i]
        i += 1
        local = h & 0x0F
        if h & 0x40:                                   # definition message
            _res, arch, gnum, n = struct.unpack_from("<BBHB", data, i)
            assert arch == 0, "big endian not expected"
            i += 5
            fields = []
            for _ in range(n):
                num, sz, typ = struct.unpack_from("<BBB", data, i)
                fields.append((num, sz, typ))
                i += 3
            defs[local] = (gnum, fields)
        else:
            gnum, fields = defs[local]
            msg = {}
            for num, sz, typ in fields:
                v = struct.unpack_from("<" + TYPES[typ], data, i)[0]
                i += sz
                msg[num] = None if v == INVALID[typ] else v
            out.append((gnum, msg))
    return out


def messages(data: bytes, gnum: int):
    return [m for g, m in read_fit(data) if g == gnum]
