"""
Force UTF-8 stdio regardless of the OS locale.

Windows embedded Python defaults stdout/stderr/stdin to the active console
codepage (cp1252, cp932, ...). Any print() containing non-ASCII characters
(e.g. "→", "…") then crashes with UnicodeEncodeError, and reading UTF-8
output under a legacy codepage can kill pipe reader threads. Reconfiguring
all three streams to UTF-8 makes Modly and extension workers agree with the
UTF-8 pipe readers used on the Electron side.
"""
import sys


def ensure_utf8_stdio() -> None:
    """Reconfigure stdin/stdout/stderr to UTF-8 when the streams support it."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass