"""
Ollama health check for the chat agent: is the server reachable, and is the
configured model pulled? Answers in a structured status the UI turns into an
actionable message ("ollama serve" / "ollama pull <model>").
"""
import httpx

# Short: this runs when the chat panel opens, and a down Ollama must not stall it.
TIMEOUT_S = 3.0


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
    root = native_base_url(base_url)
    model = model.strip()
    result: dict = {"status": "ok", "base_url": root, "model": model}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            r = await client.get(f"{root}/api/tags")
        if r.status_code != 200:
            return {**result, "status": "unreachable", "detail": f"HTTP {r.status_code} from {root}/api/tags"}
        entries = r.json().get("models", [])
    except httpx.HTTPError as e:
        return {**result, "status": "unreachable", "detail": str(e) or type(e).__name__}
    except (ValueError, AttributeError):
        return {**result, "status": "unreachable", "detail": f"{root} did not answer like an Ollama server"}

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
