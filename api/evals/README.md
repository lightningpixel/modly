# Agent eval harness

Measures whether the Modly agent calls the **right tools with valid params** for
a set of representative requests. Run it after any change to the system prompt,
the tool schemas, or the model — a number going down is a regression you'd
otherwise only notice in production.

## Run

The Modly API must be running (start the app, or the FastAPI backend on :8765).

**Start it with an empty agent memory**, or the score is not comparable to
anyone else's: `agent_memory.index()` puts every note saved on this machine into
the system prompt, and the agent then spends turns on `recall` instead of acting.
Cases are self-contained; the memory is the one thing that leaks in.

```bash
cd api
MODLY_MEMORY_DIR=$(mktemp -d) python -m uvicorn main:app --port 8765
```

```bash
cd api
python evals/run_evals.py                        # local default model
python evals/run_evals.py --model qwen3-4b       # pin a local model
python evals/run_evals.py --repeat 5             # per-case pass RATE, not a single sample
python evals/run_evals.py --repeat 5 --json > baseline.json
python evals/run_evals.py --only wiring          # substring filter on case names
python evals/run_evals.py --provider external \
    --base-url https://api.openai.com/v1 --api-key sk-... --model gpt-4o
```

Output is one line per case (`✓`/`✗` + the tools it called) and a final score.
Exit code is non-zero if any case falls below `--min-rate` (default 1.0), so it
can gate a comparison script.

**Always use `--repeat` when comparing two versions.** A small local model
samples: 12/12 on one pass is not evidence that a change helped, and a single
red case is not evidence that it hurt. `--json` writes the full per-run report
so two baselines can be diffed.

## How it works

- `cases.json` — each case is self-contained: a user message plus a synthetic
  `context` (extensions/workflows). Grading therefore depends only on the model
  and the prompt, not on what's installed locally.
- `run_evals.py` — POSTs each case to `/agent/chat`, collects the `action` and
  `done` SSE events, and grades with `grader.py`.
- `grader.py` — pure grading. Unit-tested offline in
  `tests/test_evals_grader.py`, no live model needed.

## Comparing two versions of the agent itself

Two runs against the **same** server share its KV cache and its warm-up, and two
runs against different servers do not compare either: the same case has scored
2/15 and 14/15 on two backends started from identical code. So a change to the
agent is measured A/B/A — old, new, old again — with the drift between the two
old runs as the bar the new one has to clear.

The push-back on a turn that only looked things up has an off switch for exactly
this:

```bash
MODLY_AGENT_PUSHBACK=0 MODLY_MEMORY_DIR=$(mktemp -d) python -m uvicorn main:app --port 8765
```

## Constrained tool arguments (`spike_enums.py`)

`routers/agent.py` can inject `enum` into tool arguments built from live app
state (workflow ids, extension ids, step numbers, param ids). llama.cpp compiles
tool schemas into GBNF, so an id outside the enum becomes impossible to emit
rather than merely wrong.

It is **off by default** (`_DYNAMIC_ENUMS`), because `tool_choice: "required"`
also looked supported and silently wasn't — honoured with one tool, ignored with
fifteen. Measure before trusting:

```bash
cd api
python evals/spike_enums.py            # probes the llama-server directly
```

If it passes, turn the feature on and measure the gain against the baseline:

```bash
MODLY_AGENT_ENUMS=1 python evals/run_evals.py --repeat 5 --json > with-enums.json
```

## Adding a case

Append to `cases.json`:

```json
{
  "name": "short description",
  "user": "the user's message",
  "context": { "extensions": [ … ], "workflows": [ … ] },
  "expect": {
    "tools_include": ["set_param"],
    "payload_includes": [{ "set_params": [{ "step": 1, "params": { "resolution": 2048 } }] }]
  }
}
```

Supported `expect` keys:

| key | asserts |
|---|---|
| `tools_include` | every listed tool was called |
| `tools_exclude` | none of the listed tools was called |
| `no_param_error` | no tool result carried an "Unknown param"/"Invalid value" error |
| `payload_includes` | the action payload the app would apply contains this subset |
| `payload_excludes` | no action payload contains this subset (the wrong extension, the wrong step) |
| `final_includes` | the final message contains these substrings |
| `no_tools` | the agent asked instead of acting |
| `allow_error` | a stream error doesn't fail the case |

**A case about *which* extension was chosen needs `payload_excludes` too.**
`payload_includes` matches a subset, so a chain that bolts the two wrong steps
onto the right one still passes. Name the wrong ones explicitly.

## The `disambiguate:` block

Those cases all describe several extensions with the **same signature** and
deliberately opaque product names (`PyMeshLab`, `Instant Meshes`, `TRELLIS 2`),
so neither the types nor the name say what the thing is for. Each carries a
`description` in its context — which the agent context **drops** today
(`src/shared/services/agentChat.ts`, `_build_messages` in `routers/agent.py`).
They are the before/after measurement for piping that description into the
prompt: a low baseline here is the expected result, not a bug to fix by
rewording the cases.

**Prefer `payload_includes` over `no_param_error` alone for any case about a
value.** Which tool the model picked says nothing about what it wrote, and a
constrained-decoded *valid but wrong* param id raises no error at all — a case
graded only on `no_param_error` would go green while the mutation is wrong.
`payload_includes` matches as a deep subset, so a case only spells out the keys
it cares about.
