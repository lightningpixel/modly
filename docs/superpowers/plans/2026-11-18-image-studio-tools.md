# Image Studio Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Image Studio header sliders with tool icons, a contextual options bar, and an interactive crop frame.

**Architecture:** The page owns `activeTool` and two DOM slots (an options bar under the header, an overlay layer in the canvas). Each op control keeps its own state as today, renders its icon in the header, and portals its options (and, for crop, its overlay) into the slots. Crop geometry is a pure, unit-tested module; the backend crop op accepts float percentages.

**Tech Stack:** React 18 + TypeScript + Tailwind (renderer), `node:test` (JS tests), FastAPI + Pillow + `unittest` (backend).

**Spec:** `docs/superpowers/specs/2026-11-18-image-studio-tools-design.md`

## Global Constraints

- English only in code, comments, commit messages. No attribution trailer in commits.
- Do not commit: the coordinator commits. Do not touch files outside your task's list.
- Keep the generic path: an unknown op id gets the fallback wand icon and `ParamFields` options.
- Style with the page's existing zinc/accent Tailwind classes.
- JS tests: `npm run test:node`. Python tests: from `api/`, `.venv/Scripts/python.exe -m unittest tests.test_image_ops_framing tests.test_image_ops_registry`. Lint: `npm run lint` must stay at 0 problems.

## Review Focus

1. The window or canvas resizes during a crop: the frame must stay on the same image pixels (overlay mapping recomputed via `ResizeObserver`). — Task 4, manual check.
2. The selected image changes while crop is active: the frame resets to the new input's full image. — Task 4 (`key` on the input id).
3. Images smaller than 16 px: the minimum size becomes the image size, no NaN or inverted rect. — Task 2 test `min size never exceeds a tiny image`.
4. Pointer released outside the canvas: the drag ends (pointer capture). — Task 4.
5. Enter/Esc typed in a number field of the options bar: ignored by the shortcuts. — Tasks 3 and 4 use `isTextField(event.target)`.

---

### Task 1: Backend crop takes float percentages

**Files:**
- Modify: `api/services/image_ops/builtin.py` (`_edge_param`, `crop`)
- Test: `api/tests/test_image_ops_framing.py`

**Interfaces:**
- Produces: op `crop` params `left|top|right|bottom`: `type "float"`, `default 0.0`, `min 0.0`, `max 100.0`, `step 0.1`.

- [ ] **Step 1: Update/add tests**
  - `test_crop_edges_are_clamped`: `resolve_params("crop", {"left": 150})["left"] == 100.0`.
  - `test_crop_accepts_fractional_percentages`: on a 1000×500 image, `{"left": 12.5, "top": 10.2}` → output size `(875, 449)` (`crop_box` rounds: x0=125, y0=51).
  - `test_crop_refuses_an_empty_box`: `{"left": 60, "right": 40}` raises `ImageOpInputError`; same for `top+bottom >= 100`.
- [ ] **Step 2: Run, expect the new tests to FAIL.**
- [ ] **Step 3: Implement** the schema change and, in `crop`, raise `ImageOpInputError("Nothing left to crop: the frame is empty.")` when `left + right >= 100` or `top + bottom >= 100`. Update the tooltip to "Percentage of the image cut off the {edge} edge."
- [ ] **Step 4: Run both test modules, expect PASS.**

### Task 2: Crop geometry module

**Files:**
- Create: `src/areas/image-studio/cropGeometry.ts`
- Test: `src/areas/image-studio/cropGeometry.test.ts`

**Interfaces (Produces):**
```ts
export interface ImageSize { width: number; height: number }
export interface Rect { x: number; y: number; w: number; h: number }   // integer image pixels
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'
export type AspectMode = 'free' | 'square' | 'original'
export const MIN_CROP_PX = 16
export function fullRect(size: ImageSize): Rect
export function minCropSize(size: ImageSize): { w: number; h: number }      // min(16, side) per axis
export function aspectRatio(mode: AspectMode, size: ImageSize): number | null  // w / h; free → null
export function fitToRatio(rect: Rect, ratio: number | null, size: ImageSize): Rect
export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, size: ImageSize, ratio: number | null): Rect
export function cropEdges(rect: Rect, size: ImageSize): { left: number; top: number; right: number; bottom: number } // percent
export function isFullRect(rect: Rect, size: ImageSize): boolean
```
Semantics: `dx/dy` are image-pixel deltas from the drag start (the caller always passes the `start` rect captured at pointerdown). Results are rounded to integers, inside the image, at least `minCropSize`. `move` translates, clamped. Edge/corner handles move the dragged edges; the opposite edges stay put. With a ratio: corner handles keep the opposite corner as anchor and size from the larger of the two proposed dimensions, shrunk to fit the image; edge handles change the dragged dimension and the other one follows, centered on the rect's perpendicular center, shrunk to fit. `fitToRatio` returns the largest rect of that ratio inside `rect`, centered on it (`null` returns `rect`).

- [ ] **Step 1: Write failing tests** (size 200×100 unless stated):
  - `fullRect` → `{x:0,y:0,w:200,h:100}`; `isFullRect(fullRect(s), s) === true`.
  - `move` by (50, 50) from `{x:10,y:10,w:100,h:50}` → `{x:60,y:50,w:100,h:50}`; by (500, 0) → `x: 100`.
  - `e` by +30 from `{x:0,y:0,w:100,h:100}` → `w:130`; `w` by +95 from `{x:0,y:0,w:100,h:100}` → `{x:84, w:16}` (min size).
  - `se` by (+500,+500) from `{x:0,y:0,w:50,h:50}` → `{w:200,h:100}`.
  - `nw` by (-20,-20) from `{x:10,y:10,w:50,h:50}` → `{x:0,y:0,w:60,h:60}`.
  - ratio 1: `se` by (+40, +10) from `{x:0,y:0,w:50,h:50}` → `{w:90,h:90}`; by (+300,+300) → `{w:100,h:100}` (fits height).
  - ratio 1: `e` by +20 from `{x:50,y:25,w:50,h:50}` → `{w:70,h:70}`, vertically centered then clamped into the image (`y` in `[0, 30]`).
  - `fitToRatio({x:0,y:0,w:200,h:100}, 1, s)` → `{x:50,y:0,w:100,h:100}`; `aspectRatio('original', s) === 2`; `aspectRatio('free', s) === null`.
  - `cropEdges({x:20,y:10,w:100,h:50}, s)` → `{left:10, top:10, right:40, bottom:40}`.
  - `min size never exceeds a tiny image`: size 8×4 → `minCropSize = {w:8,h:4}`; `dragRect(fullRect, 'w', 100, 0, …)` → `{x:0,w:8}`.
- [ ] **Step 2: Run `npm run test:node`, expect FAIL (module missing).**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

### Task 3: Tool icons, options bar slot, active tool

**Files:**
- Create: `src/areas/image-studio/imageOpIcons.tsx`
- Modify: `src/areas/image-studio/ImageOpsToolbar.tsx`, `src/areas/image-studio/ImageStudioPage.tsx`
- Modify: `src/areas/image-studio/imageOps.ts` (add `isTextField`), test in `imageOps.test.ts`

**Interfaces:**
- Produces:
  - `export function ImageOpIcon({ opId, size }: { opId: string; size?: number }): JSX.Element` — crop, remove_background, auto_frame icons; wand fallback.
  - `export function isTextField(target: EventTarget | null): boolean` in `imageOps.ts` — true for `input` (non-button/checkbox/range types), `textarea`, `select`, `contentEditable`.
  - `ImageOpsToolbar` props: `entries`, `selected`, `onResult`, `onActivity` (unchanged) plus `activeTool: string | null`, `onActiveToolChange: (id: string | null) => void`, `optionsSlot: HTMLElement | null`, `overlaySlot: HTMLElement | null`.
  - Inside `ImageOpsToolbar.tsx`, `ImageOpControl` exposes to the crop UI (Task 4) a `start(params?: Record<string, unknown>): Promise<boolean>` (true when a result was added) and `running`, `busy`. Leave a single branch `op.id === 'crop'` that Task 4 fills; in this task crop uses the generic options.
  - `Canvas` gets `hideToggles: boolean` and renders `<div ref={onOverlaySlot} className="absolute inset-0 empty:hidden" />` above the image.

- [ ] **Step 1: Failing test** in `imageOps.test.ts`: `isTextField` true for a stub `{ tagName: 'INPUT', type: 'number' }` and `{ tagName: 'TEXTAREA' }`, false for `{ tagName: 'INPUT', type: 'checkbox' }`, `{ tagName: 'BUTTON' }`, `null`. (Duck-typed: read `tagName`, `type`, `isContentEditable`.)
- [ ] **Step 2: Implement `isTextField`, run tests, PASS.**
- [ ] **Step 3: Page:** `activeTool` state (reset to null when `selected` is undefined); slots via `useState<HTMLDivElement | null>` callback refs; under `<header>` a `<div ref={setOptionsSlot} className="relative flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 empty:hidden" />`. "Add image" and "Show in folder" become icon-only buttons with `title` and `aria-label`; "Send to Generate" unchanged. Pass `hideToggles={activeTool === 'crop'}`.
- [ ] **Step 4: Toolbar:** each control renders an icon button in the header (`title={op.label}`, `aria-pressed`, accent styling when active, spinner while running, disabled when another op runs) toggling `onActiveToolChange`. When active, `createPortal` into `optionsSlot`: op label, `ParamFields` in a row (`flex items-center gap-3`), Apply button, and the `SetupCardView` (anchored to the bar). Esc on `window` (not in a text field) closes the active tool.
- [ ] **Step 5: Verify:** `npm run lint` 0, `npm run build` OK, `npm run test:node` PASS.

### Task 4: Crop tool (overlay + options)

**Files:**
- Create: `src/areas/image-studio/CropTool.tsx`
- Modify: `src/areas/image-studio/ImageOpsToolbar.tsx` (the `op.id === 'crop'` branch only)

**Interfaces:**
- Consumes: Task 2 module; Task 3's `start`, `running`, `busy`, `optionsSlot`, `overlaySlot`, `isTextField`, `onActiveToolChange`; `runInputFor(entries, selected, 'crop')`.
- Produces: `export default function CropTool(props: { input: StudioImage; optionsSlot: HTMLElement | null; overlaySlot: HTMLElement | null; running: boolean; busy: boolean; onApply: (edges: { left: number; top: number; right: number; bottom: number }) => Promise<boolean>; onCancel: () => void }): JSX.Element`. Rendered with `key={input.id}` so the frame resets when the input changes.

- [ ] **Step 1: Overlay** (portal into `overlaySlot`): an opaque zinc-950 layer with the input's `<img>` (object-contain); natural size from `onLoad`; displayed box computed from the container size via `ResizeObserver`; the frame drawn in screen px from the image rect; outside dimmed with four `bg-black/60` divs; 8 handles (8×8 px, white, with `cursor` per handle) plus the frame interior as `move`; pointerdown captures the pointer and records start rect; pointermove converts screen delta to image px (`/ scale`) and calls `dragRect`; thirds grid lines only while dragging.
- [ ] **Step 2: Options** (portal into `optionsSlot`): "Crop", a 3-way segmented control Free / 1:1 / Original (changing it applies `fitToRatio`), `{w} × {h} px`, Reset (`fullRect`), Cancel (`onCancel`), Apply (accent; disabled when `isFullRect` or `busy`; spinner while `running`). Enter applies, Esc cancels — ignoring text fields.
- [ ] **Step 3: Wire** in `ImageOpControl`: `onApply = (edges) => start(edges)`; on true, `onActiveToolChange(null)`. `onCancel = () => onActiveToolChange(null)`.
- [ ] **Step 4: Verify:** lint 0, build OK, all tests PASS; then run the app (`npm run dev`) and check crop end to end: drag edges/corners/move, ratios, resize the window mid-crop, apply → new history entry with the expected size, Esc cancels.
