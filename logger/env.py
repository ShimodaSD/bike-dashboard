"""Settings from a .env file in the repo root (gitignored), e.g.

    ANTHROPIC_API_KEY=sk-ant-...
    GARMIN_API_KEY=...        (Garmin Connect Personal API key)

Lines are KEY=value (optional quotes, # comments). A variable already set in the
environment wins, so `ANTHROPIC_API_KEY=... uv run ...` still works. Values are never
printed or logged.
"""
import os


def load_env(path):
    """Read KEY=value lines from `path` into os.environ (existing variables win).
    Returns the keys it found. A missing file is not an error."""
    found = []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return found
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        elif " #" in val:
            val = val.split(" #", 1)[0].rstrip()
        if key:
            found.append(key)
            os.environ.setdefault(key, val)
    return found
