# Image Studio: tool icons and interactive crop

## Intent

The Image Studio header is a wall of sliders: four crop percentages, edge
hardness, margin, resolution, each next to its own button. The maintainer wants
it to work like the Windows Photos editor: a row of tool icons, the options of
the active tool only, and a crop you do by dragging a frame on the image, then
confirming.

## Goals

- Header: title, one icon per image op, then Add image / Show in folder / Send to Generate.
- Clicking an icon makes it the active tool (highlighted). Clicking it again, or Esc, closes it.
- A thin options bar under the header shows the active tool's params and its action buttons. Nothing shows when no tool is active.
- Crop mode: a frame over the image with 8 handles (4 corners, 4 edges); dragging inside moves it; the image outside the frame is dimmed; a rule-of-thirds grid shows while dragging. The options bar holds the aspect ratio (Free, 1:1, Original), the result size in pixels, Reset, Cancel and Apply. Enter applies, Esc cancels.
- Applying writes a new file through the existing `crop` op and adds it to the history, as today.

## Non-goals

- No rotate, flip, zoom or pan of the canvas.
- No new image ops.
- No change to how results, history or "Send to Generate" work.

## Anti-goals

- A tool whose options cover the image being edited.
- Losing the generic toolbar: an op added to the backend registry must still appear (with a fallback icon and its params rendered by `ParamFields`) with no front-end change.

## Approaches

- **A. Popover under each icon.** Cleanest header, but the popover covers the image, and the crop's Apply/Cancel would float over the area being cropped.
- **B. Contextual options bar under the header (picked).** Matches Windows Photos, the reference the maintainer gave; one place for every tool's options and for the crop's Apply/Cancel; the image keeps the full width.
- **C. Side panel.** Familiar from pro tools, but takes width from the image permanently for three tools.

The maintainer picked B.

## Design

### Backend (`api/services/image_ops`)

- `crop` params stay `left`, `top`, `right`, `bottom` (percent of the side cut off each edge), but become `float`, `min 0`, `max 99`, `step 0.1`. The 45 % limit goes.
- `crop` raises `ImageOpInputError` when `left + right >= 100` or `top + bottom >= 100` (nothing left to keep). `framing.crop_box` already rounds to pixels and keeps at least 1 px.
- Tests in `api/tests/test_image_ops_framing.py` follow (the clamp test moves from 45 to 99, plus the new error).

### Front end (`src/areas/image-studio`)

- **Active tool state** lives in `ImageStudioPage` (`activeTool: string | null`), so the header icons, the options bar and the canvas agree. It resets to null when no image is selected.
- **Icons**: a map from op id to icon (`crop`, `remove_background`, `auto_frame`), with the current wand as the fallback for unknown ops. Each icon button has the op label as tooltip and `aria-pressed`. While an op runs, its icon shows a spinner and the other icons are disabled (the existing `RunLock`).
- **Options bar**: for a generic op, its `ParamFields` laid out in a row plus an Apply button; the one-time-download card (`SetupCardView`) anchors under this bar. The per-op state (params, setup card, readiness) keeps working as `ImageOpControl` does today; it is split so the icon and the options render in two places of the layout.
- **Crop** is the one op with its own UI, keyed by op id `crop`:
  - `cropGeometry.ts`, pure and unit-tested: a rect in image pixels; drag of a handle or of the whole frame given a pointer delta in image pixels; clamping to the image; a minimum size (16 px or the image size if smaller); aspect-ratio lock (free, 1:1, original) applied from the handle being dragged; conversion to the op's four edge percentages.
  - `CropOverlay.tsx`: drawn over the canvas image, maps screen to image pixels from the displayed `<img>` box (object-contain), pointer events with capture, the dimmed outside, the thirds grid while dragging, handle cursors.
  - The image cropped is `runInputFor(entries, selected, 'crop')`, as today: cropping a crop starts again from its source, so the overlay shows that source. The frame starts as the whole image, and resets when the selected image changes.
  - While crop is active, the "What the model sees" and "Mask" toggles are hidden.
- **Keyboard**: Esc closes the active tool (cancels a crop); Enter applies the crop. Neither fires while the focus is in a text field.

## Left to the builder

- Exact SVG paths of the three icons, spacing and colours (follow the page's zinc/accent classes).
- How `ImageOpControl` is split (a hook per op, or a component rendered twice with a slot); the constraint is one source of state per op.
