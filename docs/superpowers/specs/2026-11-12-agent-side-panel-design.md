# Agent side panel: design

## Intent

The agent today lives in the "chat" mode of the Generate page's left panel. It loses its conversation whenever that panel or the page changes. The user wants the agent available **all the time**, in a panel on the right that **pushes the whole app**, so that the app can be driven entirely through the agent.

## Goals

- **Global panel.** A right-side panel lives in `MainLayout`, next to `<main>`, and pushes the content rather than overlaying it.
  - A TopBar button toggles it, and so does `Ctrl+L` (my call).
  - Its width can be resized by dragging (min 320, max 640, default 380; my call).
  - Its open state and width are remembered across restarts.
- **Chat moves out of Generate.**
  - `WorkflowPanel` loses its basic/chat toggle and keeps basic mode only.
  - `ChatPanel` moves to `src/shared/components/agent/` as the panel body, keeping its current behaviour (streaming, thinking, actions card, mesh undo, workflow progress, image attachments).
- **The agent acts on the whole app without navigating.** It works on the page's state through stores, IPC and the API, never by changing `currentPage`, and confirms what it did in the panel.
- **Destructive actions ask first.** The panel shows a Confirm / Cancel card and the agent waits for the answer. This applies to uninstalling an extension, deleting model weights, deleting or overwriting a workflow, and changing a storage folder.
- **Conversations are persisted.**
  - Each conversation is a JSON file in `<userData>/agent/conversations/{id}.json`.
  - The panel lists past conversations (title, date) and offers New, Open and Delete.
  - Images attached to messages are stored inline as data URLs (my call; simple, and good enough at this scale).
- **Context everywhere.** Every request sends the current page, the mesh (path, triangles), workflows, installed extensions, downloaded models and storage paths.

## New agent tools

**Server-side tools** run in `execute_tool` and call the local API:

| Tool | Does |
|---|---|
| `generate_from_image(model_id?)` | Starts a generation from the image attached to the message. The frontend runs it, as with `run_workflow`. |
| `list_extensions` | Lists installed extensions (from context). |
| `get_settings` | Returns the storage paths and a few UI options (from context). |

**Client-side tools** need Electron IPC or renderer stores, so the frontend runs them:

| Tool | Confirm? |
|---|---|
| `install_extension(github_url)` | no |
| `uninstall_extension(extension_id)` | **yes** |
| `reload_extensions` | no |
| `download_model_weights(extension_id, variant?)` | no |
| `delete_model_weights(extension_id, variant?)` | **yes** |
| `delete_workflow(workflow_id)` | **yes** |
| `open_workflow(workflow_id)` | no (opens it in the workflows store, does not navigate) |
| `set_setting(key, value)`, with key in `uiScale` / `useAtkinsonFont` / `showRamIndicator` | no |
| `set_storage_folder(kind, path)` | **yes** |
| `undo_mesh` / `redo_mesh` | no |
| `navigate(page)` | no; only when the user explicitly asks to go to a page |

## Client tool bridge

This is the core mechanism.

1. The LLM calls a client tool. `_chat_events` does not run it. It yields a `client_tool` event `{id, tool, arguments, confirm}`, registers an `asyncio.Future` under the call id, and awaits it.
2. The panel runs the tool through a frontend registry (`clientTools.ts`, mapping each tool name to an async handler that returns a result string). When `confirm` is set, it first shows the Confirm / Cancel card. Cancel resolves with "The user declined."
3. The panel sends `POST /agent/tool-result {call_id, result, error?}`. The future resolves, the result goes into `messages` as a real `role: tool` message, and the loop continues in the same turn.
4. Timeouts work differently depending on whether the user is involved:
   - Execution is bounded by `tool_timeout`.
   - Waiting for the user to confirm is not bounded by it, but is capped at 10 minutes.
   - If the stream disconnects, the futures are cancelled.
5. Which tools run on the client, and which of those need confirmation, is declared once on the backend in a `CLIENT_TOOLS` dict. The frontend just obeys `confirm`.

This replaces nothing that exists today. `mesh_update`, `create_workflow` and `run_workflow` payloads keep working.

## Non-goals

- No page navigation as a side effect of an action.
- No change to the providers or to Settings > Agent.
- No change to the MCP server.

## Anti-goals

- The agent performing a destructive action without an explicit Confirm click.
- Losing the conversation when the page changes.

## Left to the builder

Visual details of the panel and the conversation list, as long as they match the existing zinc/violet style.
