"""
Ollama health check for the chat agent: is the server reachable, and is the
configured model pulled? Answers in a structured status the UI turns into an
actionable message ("ollama serve" / "ollama pull <model>").
"""
from urllib.parse import urlsplit

import httpx

# Short: this runs when the chat panel opens, and a down Ollama must not stall it.
TIMEOUT_S = 3.0

# The API answers any origin (CORS *), so a web page could call this endpoint.
# Only local addresses are probed, and nothing of the upstream answer is echoed,
# so it can't be used to map the user's network.
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def is_local_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    return (
        parts.scheme in ("http", "https")
        and not parts.username
        and not parts.password
        and host in LOOPBACK_HOSTS
    )


def native_base_url(base_url: str) -> str:
    """The chat goes through Ollama's OpenAI-compatible API under `/v1`; the
    native API (`/api/tags`) lives at the server root."""
    url = base_url.strip().rstrip("/")
    if url.endswith("/v1"):
        url = url[: -len("/v1")]
    return url


def _with_tag(name: str) -> str:
    # Ollama resolves an untagged name to `:latest`.
    return name if ":" in name else f"{name}:latest"


async def check(base_url: str, model: str) -> dict:
    """Raises ValueError when `base_url` is not a local http(s) address."""
    root = native_base_url(base_url)
    if not is_local_url(root):
        raise ValueError("base_url must be a local http(s) address (localhost, 127.0.0.1 or ::1)")
    model = model.strip()
    result: dict = {"status": "ok", "base_url": root, "model": model}
    not_ollama = {**result, "status": "unreachable", "detail": "not an Ollama server"}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False) as client:
            r = await client.get(f"{root}/api/tags")
        if r.status_code != 200:
            return not_ollama
        entries = r.json().get("models", [])
    except httpx.TimeoutException:
        return {**result, "status": "unreachable", "detail": "timed out"}
    except httpx.HTTPError:
        return {**result, "status": "unreachable", "detail": "connection refused"}
    except (ValueError, AttributeError):
        return not_ollama

    available = sorted({
        str(m.get("name") or m.get("model"))
        for m in entries
        if isinstance(m, dict) and (m.get("name") or m.get("model"))
    })
    result["available"] = available

    if not model:
        return {**result, "status": "no_model"}
    if _with_tag(model) not in {_with_tag(n) for n in available}:
        return {**result, "status": "model_missing"}
    return result
