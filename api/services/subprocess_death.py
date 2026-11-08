"""
Explains why an extension subprocess died (#369).

"Subprocess died unexpectedly" told users nothing: the real cause (CUDA out of
memory, a missing DLL, the OS killing the process) was only on the child's
stderr, which went to the logs and never into the error. This turns the exit
code and the last stderr lines into a message a user can act on.
"""
import re
from typing import Iterable, Optional

# Lines kept in the message, and the longest line we quote.
TAIL_LINES = 20
MAX_LINE = 300

# tqdm progress bars: "Loading:  45%|████▌     | 9/20 [00:03<00:04, 2.51it/s]"
_PROGRESS_RE = re.compile(r"\d+%\|.*\||\|\s*\d+/\d+\s*\[")

# Checked in order: the first matching pattern wins.
_STDERR_CAUSES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|MPS backend out of memory", re.I),
     "the GPU ran out of memory (VRAM). Close other GPU-heavy apps, lower the "
     "resolution or quality settings, or pick a lighter model."),
    (re.compile(r"paging file is too small|os error 1455|error code 1455", re.I),
     "Windows ran out of virtual memory while loading the model. Increase the "
     "paging file size (System > Advanced system settings > Performance > "
     "Virtual memory) or free up RAM."),
    (re.compile(r"DefaultCPUAllocator: (?:can't allocate|not enough) memory|\bMemoryError\b", re.I),
     "the computer ran out of RAM. Close other applications or pick a lighter model."),
    (re.compile(r"no kernel image is available|not compatible with the current PyTorch installation", re.I),
     "the PyTorch build installed for this extension does not support your GPU. "
     "Try repairing the extension, or check that the extension supports your GPU."),
    (re.compile(r"Found no NVIDIA driver|CUDA driver version is insufficient|NVIDIA driver on your system is too old", re.I),
     "the NVIDIA driver is missing or too old. Update your GPU driver."),
    (re.compile(r"DLL load failed", re.I),
     "a system library (DLL) could not be loaded. Installing the latest "
     "Microsoft Visual C++ Redistributable and repairing the extension usually fixes it."),
    (re.compile(r"No module named ['\"]([^'\"]+)['\"]"),
     "a Python package is missing from the extension ({0}). Repair the extension "
     "from the Models page to reinstall its dependencies."),
    (re.compile(r"Unable to load weights from checkpoint|HeaderTooLarge|Error while deserializing header|incomplete metadata", re.I),
     "the model files look corrupted or incomplete (often an interrupted download). "
     "Delete the model and download it again."),
]

# Windows NTSTATUS codes, as Python reports them (unsigned).
_WINDOWS_CODES: dict[int, str] = {
    0xC0000005: ("access violation: the extension crashed in native code "
                 "(GPU driver, CUDA or a compiled library)"),
    0xC0000409: ("the extension aborted in native code (often a GPU driver or "
                 "CUDA library problem)"),
    0xC0000135: "a required DLL was not found",
    0xC000001D: "illegal instruction: a library was built for a newer CPU than this one",
    0xC00000FD: "stack overflow in native code",
    0xC000012D: "Windows ran out of virtual memory; increase the paging file size or free up RAM",
    0xC0000017: "Windows ran out of memory",
}

# POSIX: Popen reports death by signal N as -N.
_SIGNALS: dict[int, str] = {
    9: ("the process was killed (SIGKILL). On Linux this is usually the "
        "out-of-memory killer: the computer ran out of RAM"),
    11: "segmentation fault: the extension crashed in native code (GPU driver, CUDA or a compiled library)",
    6: "the extension aborted (SIGABRT), usually from a native library",
    4: "illegal instruction: a library was built for a newer CPU than this one",
    7: "bus error in native code",
}


def describe_exit_code(returncode: Optional[int]) -> Optional[str]:
    """The exit code as people search for it: a signal, an NTSTATUS in hex, or
    the plain number. likely_cause() explains it."""
    if returncode is None:
        return None
    unsigned = returncode & 0xFFFFFFFF
    if unsigned in _WINDOWS_CODES:
        return f"0x{unsigned:08X}"
    if returncode < 0:
        return f"signal {-returncode}"
    return str(returncode)


def relevant_lines(lines: Iterable[str]) -> list[str]:
    """The last stderr lines worth showing: no progress bars, no blanks."""
    kept = [
        line.rstrip() for line in lines
        if line.strip() and not _PROGRESS_RE.search(line)
    ]
    return [
        line if len(line) <= MAX_LINE else line[:MAX_LINE] + "…"
        for line in kept[-TAIL_LINES:]
    ]


def likely_cause(lines: list[str], returncode: Optional[int]) -> Optional[str]:
    """The most probable cause, from stderr first, then from the exit code."""
    text = "\n".join(lines)
    for pattern, cause in _STDERR_CAUSES:
        match = pattern.search(text)
        if match:
            return cause.format(*match.groups())
    if returncode is not None:
        if returncode < 0 and -returncode in _SIGNALS:
            return _SIGNALS[-returncode] + "."
        unsigned = returncode & 0xFFFFFFFF
        if unsigned in _WINDOWS_CODES:
            return _WINDOWS_CODES[unsigned] + "."
    return None


def describe_death(model_id: str, phase: str, returncode: Optional[int], stderr_lines: Iterable[str]) -> str:
    """The error message for an extension subprocess that died during `phase`."""
    tail = relevant_lines(stderr_lines)
    exit_text = describe_exit_code(returncode)
    head = f"[{model_id}] Subprocess died {phase}"
    if exit_text:
        head += f" (exit code {exit_text})"
    parts = [head + "."]
    cause = likely_cause(tail, returncode)
    if cause:
        parts.append(f"Likely cause: {cause}")
    if tail:
        parts.append("Last output from the extension:\n" + "\n".join(f"  {line}" for line in tail))
    else:
        parts.append("The extension wrote nothing to its error output before stopping.")
    return "\n\n".join(parts)
