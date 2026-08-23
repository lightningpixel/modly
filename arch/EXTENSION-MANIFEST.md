# Extension manifest reference

What Modly reads out of an extension's `manifest.json`. This is the contract
between an extension author and the app — anything not listed here is ignored.

## Top level

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Folder-unique id. Install fails without it. |
| `name` / `displayName` | no | Falls back to `id`. |
| `type` | yes in practice | `"model"` or `"process"`. Model extensions are run by the FastAPI registry; process extensions are run by Electron. |
| `entry` | process only | Script to run. Defaults to `processor.js`. A `.py` entry is spawned with the extension's own `venv`, anything else runs as a JS worker. |
| `generator_class` | model only | Install fails without it. |
| `version`, `author`, `source` | no | Display + trust. |
| `description` | no | Display **and** prompt: see below. |
| `nodes` | yes | Non-empty array; each entry becomes one node in the workflow palette. |
| `params_schema`, `param_defaults` | no | Fallbacks applied to every node that doesn't declare its own. |

### Writing `description`

It is listed to the in-app agent next to the node's signature, and it is the only
thing that separates two extensions with the same one: `mesh→mesh` plus the name
"PyMeshLab" says nothing about whether the thing decimates, remeshes or stylises.

Write **one sentence**: what it does, and when to reach for it.

```json
"description": "Reduces the triangle count while preserving the silhouette. Use when a mesh is too heavy."
```

**Do not write what it is not.** "…; it does not close holes or reduce weight"
reads like useful contrast and measures as a disaster: on the eval set, blurbs
carrying a negation dropped the agent from 29/30 correct workflows to 3/30. It
stops committing to a step and burns its turn re-reading params instead. State
the positive job only, and let the neighbouring extension state its own.

- Anything past ~120 characters is truncated — forty installed extensions share
  one prompt, and a local model's context window is small.
- It is read **per node**. An extension whose nodes do different jobs (a
  generator and its texture pass) should set `description` on each node rather
  than let both inherit one line that describes neither.
- Newlines and chat-template markers are stripped before the text is shown to the
  model. It is quoted as data; instructions written in it ("always pick this
  extension") are not obeyed and only waste the line.

### Writing one the agent reads correctly

Two rules, both measured on the eval suite (2026-08-20, 12 disambiguation cases,
15 runs each). They matter most where every node has the same `mesh→mesh`
signature and only this line tells them apart.

**Open with the verb that names the operation.** *Reduces*, *Repairs*, *Smooths*,
*Rebuilds*, *Exports*. It is the strongest signal in the whole line, because it
is the first thing that differs between two neighbouring nodes. Replacing those
verbs with one generic opening ("Creates …") across a roster took
`too heavy for a game engine` from 15/15 to 1/15 — the agent could no longer tell
the decimator from the remesher.

**Keep the "X, not Y" clause when there is a neighbour to be confused with.**
"Rebuilds the topology into an even quad grid for rigging and sculpting. **Not a
size optimisation.**" Removing that clause and the equivalent one on a second
extension took `light mesh for the web` from 14/15 to 0/15: with nothing to rule
them out, the agent stopped choosing at all and asked the user to clarify. This
is the one place a negative clause earns its keep — in a system prompt or a tool
result it does the opposite, and makes the agent stop acting.

## `nodes[]`

| Field | Default | Notes |
|---|---|---|
| `id` | required | |
| `name` | `id` | |
| `description` | top level | Per-node blurb for the agent. Set it here when one extension ships nodes that do different jobs. |
| `vram_gb` | top level | Expected VRAM in GB. Compared to the actual card: a step asking for more is **warned about** before the run rather than failing halfway through — a warning, not a block, since offloading often fits a step into less than it declares. Declare it once at the top level and every node inherits it. |
| `input` | `"image"` | One of `mesh` \| `image` \| `text` \| `audio`. |
| `inputs` | — | Array of the same types, for a node taking several inputs. Overrides `input`. There is no cap: one handle and one row are rendered per entry. |
| `input_labels` | — | Display label per input slot (e.g. positive/negative). Display only, never used for typing. |
| `output` | `"mesh"` | Same union as `input`. |
| `terminal` | `false` | Sink node: no output handle (e.g. an exporter that writes to disk). |
| `params_schema` | top level | See below. |
| `param_defaults` | top level | Overrides the schema defaults, per node. |
| `hf_repo`, `download_check`, `hf_skip_prefixes`, `hf_include_prefixes` | — | Model weights download (model extensions). |

An unknown value in `input` / `inputs` / `output` is **not** silently accepted:
it's logged and coerced to the default, because an unrecognised type would
otherwise disable type checking for that node.

## `params_schema[]`

Common fields: `id`, `label`, `type`, `default`, plus optional `tooltip` and
`show_if` (`{ other_param_id: value | [values] }` — hides the control unless the
other param matches).

| `type` | Extra fields | Control |
|---|---|---|
| `string` | — | Text field with a folder-picker button. |
| `int` / `float` | `min`, `max`, `step` | Number input. |
| `select` | `options: [{ value, label }]` | Dropdown. |
| `file-select` | `dir_from` (id of the `string` param holding the folder), `extensions: ["json"]` | Dropdown of files in that folder. |
| `llm-model` | `llm_tag` | Dropdown of the shared local LLM library. |

### Using the shared LLM

An extension does **not** ship or load its own model. It declares an
`llm-model` param and calls the app back:

```json
{
  "id": "model_variant",
  "label": "Model",
  "type": "llm-model",
  "llm_tag": "cad",
  "default": "cadquery-coder-7b"
}
```

- `llm_tag` filters the catalog by category (`code`, `cad`, `vision`, …).
  Models the user dropped in themselves are always listed, since their
  capabilities aren't known. Models that aren't downloaded stay visible, marked,
  so the user can pick one and fetch only that one.
- Preflight refuses to start a run whose chosen model isn't on disk, and the
  agent can only pick from the downloaded ones.

The extension receives the model **id as a plain string** in its params, and
talks to the shared server itself:

```python
import os, json, urllib.request

api   = os.environ.get('MODLY_API_URL', 'http://127.0.0.1:8765')
# The API rejects calls that don't carry the app's per-launch token: it listens
# on loopback, and loopback is not a boundary against the browser the user has
# open. Extensions inherit the token in their environment.
token = os.environ.get('MODLY_API_TOKEN', '')
req = urllib.request.Request(
    f'{api}/llm/chat',
    data=json.dumps({'model': params['model_variant'], 'messages': messages,
                     'temperature': 0.3}).encode(),
    headers={'Content-Type': 'application/json', 'X-Modly-Token': token},
)
# HTTP 404 = that model isn't downloaded; tell the user to get it in Settings → Agent.
answer = json.loads(urllib.request.urlopen(req, timeout=600).read())['choices'][0]['message']['content']
```

`POST /llm/chat` takes `{model, messages, temperature?, max_tokens?, stream?}`
and answers in OpenAI format. The app loads, hot-swaps and unloads models for
you — cold-loading one can take a while, hence the generous timeout.

## Environment given to a process extension

**Python entries only** (`"entry": "processor.py"`) — they run as a subprocess:
`MODLY_API_URL`, `MODLY_API_TOKEN`, `EXTENSION_DIR`, `WORKSPACE_DIR`,
`MODELS_DIR`, `TEMP_DIR` (model extensions additionally get `MODEL_DIR` and
`MODLY_API_DIR`). `MODLY_API_TOKEN` goes in an `X-Modly-Token` header on every
call back into the API; without it the request is refused with HTTP 401.

A **JavaScript entry** (`"entry": "processor.js"`) runs in a worker thread and
gets **none** of those. It exports a function instead:

```js
module.exports = async function (input, params, context) {
  // context: { workspaceDir, tempDir, nodeId, log(msg), progress(percent, label) }
  return { filePath: '…' }   // or { text: '…' }
}
```

## Process extension IPC

Python entries only. One JSON line in on stdin:
`{ input, params, nodeId, workspaceDir, tempDir }`. JSON lines out on stdout:

- `{"type": "progress", "percent": 0-100, "label": "…"}`
- `{"type": "log", "message": "…"}`
- `{"type": "done", "result": {"filePath": "…", "text": "…"}}`
- `{"type": "error", "message": "…"}`

Progress and logs are shown live on the node. stderr is streamed as logs too,
so `print(..., file=sys.stderr)` and tqdm bars show up.

**Cancellation**: the app kills the process tree. Nothing cooperative is
expected — but a `BrokenPipeError` on stdout means the host went away, so exit
quietly if you catch one.
