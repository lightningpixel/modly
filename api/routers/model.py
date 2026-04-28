import asyncio
import json
import time
import os
import socket
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from services.generator_registry import generator_registry, MODELS_DIR

router = APIRouter(tags=["model"])


@router.get("/status")
async def model_status():
    """Status of the active model."""
    return generator_registry.active_status()


@router.get("/all")
async def all_models_status():
    """Status of all known models (downloaded, loaded, required VRAM)."""
    return generator_registry.all_status()


@router.get("/params")
async def model_params(model_id: Optional[str] = None):
    """Parameter schema of the active model (or a specified model)."""
    try:
        return generator_registry.params_schema(model_id)
    except KeyError:
        raise HTTPException(404, f"Unknown model ID: {model_id}")


@router.post("/switch")
async def switch_model(model_id: str):
    """Switch the active model."""
    try:
        generator_registry.switch_model(model_id)
        return {"active": model_id}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/unload-all")
async def unload_all_models():
    """Unloads all models from memory to free VRAM/RAM."""
    generator_registry.unload_all()
    # Force Python to release memory back to the OS
    import gc
    gc.collect()
    try:
        import ctypes, sys
        if sys.platform == "win32":
            k32 = ctypes.windll.kernel32
            k32.SetProcessWorkingSetSizeEx(k32.GetCurrentProcess(), -1, -1, 0)
    except Exception:
        pass
    return {"unloaded": True}


@router.post("/unload/{model_id}")
async def unload_model(model_id: str):
    """Unloads a model from memory so its files can be safely deleted."""
    try:
        gen = generator_registry.get_generator(model_id)
        gen.unload()
        return {"unloaded": True}
    except ValueError:
        return {"unloaded": True}  # already not loaded, that's fine


@router.get("/hf-download")
async def hf_download(
    repo_id: str,
    model_id: str,
    skip_prefixes: Optional[str] = None,
    include_prefixes: Optional[str] = None,
    token: Optional[str] = None,
):
    """
    Streams a HuggingFace Hub model download via SSE.
    Downloads into MODELS_DIR / model_id applying the filtering
    declared in the extension manifest (hf_skip_prefixes / hf_include_prefixes).

    skip_prefixes:    JSON-encoded list of path prefixes to exclude.
    include_prefixes: JSON-encoded list of path prefixes to include (whitelist).
    token:            HuggingFace access token for gated repos (from Electron settings).
    All three fall back to the extension's manifest / environment when not supplied.

    SSE format: data: {"percent": 0-100, "file": "...", "status": "..."}
    """
    import json as _json
    import os
    dest_dir  = str(MODELS_DIR / model_id)
    # Prefer skip_prefixes passed directly from the client (authoritative, no registry dep)
    if skip_prefixes:
        try:
            skip_list = _json.loads(skip_prefixes)
        except Exception:
            skip_list = []
    else:
        try:
            skip_list = generator_registry.get_manifest(model_id).get("hf_skip_prefixes", [])
        except KeyError:
            skip_list = []

    if include_prefixes:
        try:
            include_list = _json.loads(include_prefixes)
        except Exception:
            include_list = []
    else:
        try:
            include_list = generator_registry.get_manifest(model_id).get("hf_include_prefixes", [])
        except KeyError:
            include_list = []

    # Token: explicit query param > env var > None
    hf_token = token or os.environ.get("HUGGING_FACE_HUB_TOKEN") or os.environ.get("HF_TOKEN") or None

    async def stream():
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield _fmt({"percent": 0, "status": "Listing repository files..."})

            def _list_files():
                from huggingface_hub import list_repo_files
                return [
                    f for f in list_repo_files(repo_id, token=hf_token)
                    if (not include_list or any(f.startswith(p) for p in include_list))
                    if not any(f.startswith(p) for p in skip_list)
                ]

            files = await loop.run_in_executor(None, _list_files)
            total = len(files)

            if total == 0:
                yield _fmt({"error": f"No files found in HuggingFace repo: {repo_id}"})
                return

            yield _fmt({"percent": 1, "status": f"Downloading {total} files..."})

            from huggingface_hub import hf_hub_url

            for i, filename in enumerate(files):
                yield _fmt({
                    "percent": 1 + round(i / total * 94),
                    "file": filename,
                    "fileIndex": i + 1,
                    "totalFiles": total,
                    "status": f"Starting {filename}",
                    "bytesDownloaded": 0,
                    "stalledSeconds": 0,
                })

                base_pct = 1 + round(i / total * 94)
                queue: asyncio.Queue[dict] = asyncio.Queue()

                def _progress(msg: dict) -> None:
                    loop.call_soon_threadsafe(queue.put_nowait, msg)

                url = hf_hub_url(repo_id=repo_id, filename=filename)
                dl_future = loop.run_in_executor(
                    None,
                    lambda: _download_file_streamed(
                        url=url,
                        filename=filename,
                        dest_dir=dest_dir,
                        file_index=i + 1,
                        total_files=total,
                        base_percent=base_pct,
                        progress_cb=_progress,
                        token=hf_token,
                    ),
                )

                while not dl_future.done():
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    else:
                        yield _fmt(msg)

                final_size = await dl_future

                # Reserve 1-95 for file downloads, leave 95-100 for finalisation
                pct = 1 + round((i + 1) / total * 94)
                yield _fmt({
                    "percent": pct,
                    "file": filename,
                    "fileIndex": i + 1,
                    "totalFiles": total,
                    "status": "Downloaded",
                    "bytesDownloaded": final_size,
                    "stalledSeconds": 0,
                })

            yield _fmt({"percent": 100, "status": "done"})

        except Exception as exc:
            yield _fmt({"error": str(exc)})

    return StreamingResponse(stream(), media_type="text/event-stream")


def _download_file_streamed(
    *,
    url: str,
    filename: str,
    dest_dir: str,
    file_index: int,
    total_files: int,
    base_percent: int,
    progress_cb,
    token: Optional[str] = None,
) -> int:
    final_path = Path(dest_dir) / filename
    temp_path = final_path.with_suffix(final_path.suffix + ".part")
    final_path.parent.mkdir(parents=True, exist_ok=True)

    if final_path.exists():
        return final_path.stat().st_size

    # Explicit token (from caller) > env vars > none
    hf_token = (
        token
        or os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGINGFACE_HUB_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    )
    headers = {"User-Agent": "modly/0.3.1"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    retries = 3
    backoff = 2.0
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            existing_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            request_headers = dict(headers)
            request_url = url
            if existing_bytes > 0:
                request_url = _resolve_direct_download_url(url, headers)
                request_headers["Range"] = f"bytes={existing_bytes}-"

            request = Request(request_url, headers=request_headers)
            with urlopen(request, timeout=30) as response:
                resumed = existing_bytes > 0 and getattr(response, "status", None) == 206
                if existing_bytes > 0 and not resumed:
                    temp_path.unlink(missing_ok=True)
                    existing_bytes = 0

                total_bytes = _response_total_bytes(response.headers, existing_bytes if resumed else 0)
                bytes_downloaded = existing_bytes
                last_emit = 0.0
                chunk_size = 1024 * 1024
                mode = "ab" if resumed else "wb"

                progress_cb({
                    "percent": base_percent,
                    "file": filename,
                    "fileIndex": file_index,
                    "totalFiles": total_files,
                    "status": _download_status(bytes_downloaded, total_bytes, attempt, retries, resumed=resumed),
                    "bytesDownloaded": bytes_downloaded,
                    "totalBytes": total_bytes,
                    "stalledSeconds": 0,
                })

                with open(temp_path, mode) as out:
                    while True:
                        try:
                            chunk = response.read(chunk_size)
                        except socket.timeout as exc:
                            raise TimeoutError(f"Timed out while downloading {filename}") from exc

                        if not chunk:
                            break

                        out.write(chunk)
                        bytes_downloaded += len(chunk)

                        now = time.monotonic()
                        if now - last_emit >= 0.5:
                            progress_cb({
                                "percent": base_percent,
                                "file": filename,
                                "fileIndex": file_index,
                                "totalFiles": total_files,
                                "status": _download_status(bytes_downloaded, total_bytes, attempt, retries, resumed=resumed),
                                "bytesDownloaded": bytes_downloaded,
                                "totalBytes": total_bytes,
                                "stalledSeconds": 0,
                            })
                            last_emit = now

            temp_path.replace(final_path)
            return bytes_downloaded

        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            preserved_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            progress_cb({
                "percent": base_percent,
                "file": filename,
                "fileIndex": file_index,
                "totalFiles": total_files,
                "status": f"Retrying after error ({attempt}/{retries})…",
                "bytesDownloaded": preserved_bytes,
                "stalledSeconds": 0,
            })
            if attempt >= retries:
                break
            time.sleep(backoff)
            backoff *= 2

    raise RuntimeError(f"Failed to download {filename}: {last_error}")


def _resolve_direct_download_url(url: str, headers: dict[str, str]) -> str:
    request = Request(url, headers=headers)
    with urlopen(request, timeout=30) as response:
        return response.geturl()


def _parse_content_length(raw: Optional[str]) -> Optional[int]:
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _download_status(downloaded: int, total: Optional[int], attempt: int, retries: int, resumed: bool = False) -> str:
    prefix = "Resuming…" if resumed and downloaded > 0 else "Downloading…"
    if total and total > 0:
        pct = min(100, round(downloaded / total * 100))
        return f"{prefix} {pct}%"
    if retries > 1 and attempt > 1:
        return f"{prefix} retry {attempt}/{retries}"
    return prefix


def _response_total_bytes(headers, already_downloaded: int) -> Optional[int]:
    content_range = headers.get("Content-Range")
    if content_range and "/" in content_range:
        total_raw = content_range.split("/")[-1].strip()
        try:
            return int(total_raw)
        except (TypeError, ValueError):
            pass

    content_length = _parse_content_length(headers.get("Content-Length"))
    if content_length is None:
        return None
    return already_downloaded + content_length
