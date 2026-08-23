"""
Client side of the API's per-launch token.

The backend rejects requests that cannot prove they come from a local Modly
client, so that a web page open in the user's browser cannot drive the app
(see the middleware in main.py). The processes that legitimately talk to it —
the MCP server, the eval harness, an extension calling back into /llm/chat —
find the token either in their environment, when Modly spawned them, or in the
file the app writes at launch.

Nothing here is a secret from local code: any process running as the user can
read that file. The token exists to keep browsers out, not neighbours.
"""
import os
from pathlib import Path

TOKEN_HEADER = "x-modly-token"
TOKEN_FILE = Path.home() / ".modly" / "api-token"


def read_token() -> str:
    token = os.environ.get("MODLY_API_TOKEN")
    if token:
        return token.strip()
    try:
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def local_headers() -> dict:
    """Auth header for a request to the local API, empty when there is no token
    (a backend started by hand runs without the check)."""
    token = read_token()
    return {TOKEN_HEADER: token} if token else {}
