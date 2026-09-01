/**
 * Python launcher used to run an extension's setup.py.
 *
 * Extension setup scripts are third-party code we cannot edit, and they install
 * PyTorch themselves from an index they hardcode. The launcher wraps them: it
 * patches subprocess so every pip invocation passes through a few corrections
 * before it runs — dropping CUDA-only indexes on macOS, keeping the shared wheel
 * cache alive, and redirecting torch to ROCm wheels on AMD machines.
 *
 * Kept in its own module so setup-launcher.test.mjs can execute it for real
 * against the command shapes the official extensions actually use.
 */

export const SETUP_LAUNCHER_SOURCE = `
import json
import os
import re
import runpy
import subprocess
import sys

setup_py = sys.argv[1]
setup_args = sys.argv[2:]

_TORCH_REQ_RE = re.compile(r"^(torch|torchvision|torchaudio)(\\[[^\\]]*\\])?\\s*([<>=!~].*)?$", re.I)

def _is_cuda_torch_index(value):
    return isinstance(value, str) and value.startswith("https://download.pytorch.org/whl/cu")

def _is_torch_requirement(text):
    # Matches "torch", "torch==2.6.0", "torch[device-gfx1200]==2.11.0+rocm7.14.0",
    # and the pinned direct wheel URLs the ARM64 install path uses.
    if _TORCH_REQ_RE.match(text):
        return True
    if text.startswith(("http://", "https://")):
        return any(seg in text for seg in ("/torch-", "/torchvision-", "/torchaudio-"))
    return False

def _mentions_torch(command):
    if not isinstance(command, (list, tuple)):
        return False
    return any(_is_torch_requirement(str(part)) for part in command)

def _rewrite_command(command):
    if sys.platform != "darwin" or not _mentions_torch(command):
        return command
    if not isinstance(command, (list, tuple)):
        return command

    rewritten = []
    changed = False
    i = 0
    while i < len(command):
        part = command[i]
        text = str(part)
        if text in ("--index-url", "-i", "--extra-index-url") and i + 1 < len(command) and _is_cuda_torch_index(str(command[i + 1])):
            changed = True
            i += 2
            continue
        if text.startswith("--index-url=") or text.startswith("--extra-index-url="):
            value = text.split("=", 1)[1]
            if _is_cuda_torch_index(value):
                changed = True
                i += 1
                continue
        rewritten.append(part)
        i += 1

    if changed:
        print("[Modly setup compat] Removed CUDA-only PyTorch index on macOS; pip will use macOS wheels.", file=sys.stderr)
        return rewritten
    return command

# Matches the executable spellings pip arrives under: "pip", "pip3", "pip3.11",
# "pip.exe", or a stub script like "pip.py" — but not a requirement that merely
# starts with "pip" (pipdeptree) or a script like "pipeline.py".
_PIP_BASENAME_RE = re.compile(r"^pip[0-9.]*(\\.py|\\.exe)?$", re.I)

def _is_pip_command(command):
    # Scan everything ahead of the pip subcommand, so both "<venv>/bin/pip
    # install" and "python -u -m pip install" match, while requirements after
    # "install" are never mistaken for the executable.
    if not isinstance(command, (list, tuple)):
        return False
    texts = [str(part) for part in command]
    for i, text in enumerate(texts):
        if text in ("install", "download", "wheel"):
            break
        if text == "-m" and i + 1 < len(texts) and texts[i + 1].lower() in ("pip", "pip._internal"):
            return True
        if _PIP_BASENAME_RE.match(os.path.basename(text)):
            return True
    return False

def _strip_no_cache(command):
    # Extension setup scripts often hardcode --no-cache-dir, which forces pip to
    # re-download multi-GB wheels on every retry. Modly provides a shared cache
    # via PIP_CACHE_DIR, so drop the flag and let pip use it.
    if not _is_pip_command(command):
        return command
    if not any(str(part) == "--no-cache-dir" for part in command):
        return command
    print("[Modly setup compat] Removed --no-cache-dir so pip reuses the shared wheel cache.", file=sys.stderr)
    return [part for part in command if str(part) != "--no-cache-dir"]

# ROCm redirect. Most extension setup.py scripts predate AMD support and
# hardcode a CUDA index (hunyuan3d-mini even forces the CPU index on Windows),
# so on an AMD machine we swap the whole torch install for the ROCm one Modly
# resolved. An index the extension already pointed at ROCm is left alone.
_ROCM_INDEX = os.environ.get("MODLY_TORCH_INDEX_URL", "")
try:
    _ROCM_SPECS = json.loads(os.environ.get("MODLY_TORCH_SPECS", "[]"))
except ValueError:
    _ROCM_SPECS = []

def _is_pytorch_index(value):
    return isinstance(value, str) and "download.pytorch.org/whl/" in value

def _is_rocm_index(value):
    # Covers the pytorch.org rocm indexes, AMD's Windows multi-arch index, and
    # whatever MODLY_ROCM_INDEX was overridden to.
    if not isinstance(value, str):
        return False
    if _ROCM_INDEX and value.rstrip("/") == _ROCM_INDEX.rstrip("/"):
        return True
    return "/whl/rocm" in value or "repo.amd.com/rocm" in value

_PIP_VALUE_FLAGS = (
    "--index-url", "-i", "--extra-index-url", "--find-links", "-f",
    "--retries", "--timeout", "--cache-dir", "--target", "-t",
    "--requirement", "-r", "--constraint", "-c", "--progress-bar",
    "--proxy", "--cert", "--client-cert", "--trusted-host", "--log",
    "--no-binary", "--only-binary", "--prefix", "--root", "--upgrade-strategy",
    "--python-version", "--platform", "--abi", "--implementation",
)

def _has_non_torch_requirement(command):
    # Only look past the subcommand, so the interpreter and pip executable
    # paths ahead of it are never mistaken for requirements.
    texts = [str(part) for part in command]
    start = None
    for index, text in enumerate(texts):
        if text in ("install", "download", "wheel"):
            start = index + 1
            break
    if start is None:
        return False

    skip_next = False
    for text in texts[start:]:
        if skip_next:
            skip_next = False
            continue
        if text in _PIP_VALUE_FLAGS:
            skip_next = True
            continue
        if text.startswith("-") or _is_torch_requirement(text):
            continue
        return True
    return False

def _rewrite_rocm(command):
    if os.environ.get("MODLY_TORCH_FLAVOR") != "rocm" or not _ROCM_INDEX or not _ROCM_SPECS:
        return command
    if not isinstance(command, (list, tuple)):
        return command
    if not _is_pip_command(command) or not _mentions_torch(command):
        return command

    rewritten = []
    insert_at = None
    keeps_rocm_index = False
    changed = False
    i = 0
    while i < len(command):
        text = str(command[i])
        if text in ("--index-url", "-i", "--extra-index-url") and i + 1 < len(command):
            value = str(command[i + 1])
            if _is_rocm_index(value):
                keeps_rocm_index = True
                rewritten.extend(command[i:i + 2])
            elif _is_pytorch_index(value):
                changed = True
            elif text != "--extra-index-url":
                # A foreign primary index (a PyPI mirror, pypi.nvidia.com…)
                # must not stay primary: pip resolves a duplicated --index-url
                # last-wins, so it could shadow the injected ROCm index and
                # silently hand torch back to CUDA/CPU wheels. Demote it to an
                # extra index so its other packages stay reachable.
                changed = True
                rewritten.extend(["--extra-index-url", command[i + 1]])
            else:
                rewritten.extend(command[i:i + 2])
            i += 2
            continue
        if "=" in text and text.split("=", 1)[0] in ("--index-url", "--extra-index-url"):
            flag, value = text.split("=", 1)
            if _is_rocm_index(value):
                keeps_rocm_index = True
                rewritten.append(command[i])
            elif _is_pytorch_index(value):
                changed = True
            elif flag != "--extra-index-url":
                changed = True
                rewritten.append("--extra-index-url=" + value)
            else:
                rewritten.append(command[i])
            i += 1
            continue
        if _is_torch_requirement(text):
            if insert_at is None:
                insert_at = len(rewritten)
            changed = True
            i += 1
            continue
        rewritten.append(command[i])
        i += 1

    if not changed:
        return command
    if insert_at is None:
        insert_at = len(rewritten)
    index_args = [] if keeps_rocm_index else ["--index-url", _ROCM_INDEX]
    if _has_non_torch_requirement(command) and not any("pypi.org/simple" in str(part) for part in rewritten):
        # The ROCm index only mirrors torch's own dependency closure (numpy,
        # pillow…), not application packages like trimesh or diffusers. A pip
        # call that mixes both still needs PyPI reachable — also when the
        # extension supplied the ROCm index itself.
        index_args += ["--extra-index-url", "https://pypi.org/simple"]
    injected = index_args + list(_ROCM_SPECS)
    rewritten[insert_at:insert_at] = injected
    print("[Modly setup compat] Redirected PyTorch to ROCm wheels: " + " ".join(injected), file=sys.stderr)
    return rewritten

def _transform_command(command):
    return _strip_no_cache(_rewrite_rocm(_rewrite_command(command)))

# Every subprocess entry point — run, call, check_call, check_output, and a
# direct subprocess.Popen(...) — constructs the module-global Popen, so patching
# that one class covers them all exactly once, whether the command arrives
# positionally or as the args= keyword. This also holds for code that did
# "from subprocess import run" before this launcher ran: run() still looks
# Popen up on the module at call time.
_OriginalPopen = subprocess.Popen

class _PatchedPopen(_OriginalPopen):
    def __init__(self, *args, **kwargs):
        if args:
            args = (_transform_command(args[0]),) + tuple(args[1:])
        elif "args" in kwargs:
            kwargs["args"] = _transform_command(kwargs["args"])
        super().__init__(*args, **kwargs)

subprocess.Popen = _PatchedPopen

sys.argv = [setup_py] + setup_args
runpy.run_path(setup_py, run_name="__main__")
`
