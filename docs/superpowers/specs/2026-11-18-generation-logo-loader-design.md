# Generate: playful logo loader while a mesh is generated

## Intent

While a mesh generates, the Generate viewer shows nothing but the small progress card. Showing the real mesh as it forms is not possible (generators work in latent space; the mesh exists only after the final decode, and extensions are black boxes). Instead, the maintainer wants an animated, playful Modly logo the user can play with while waiting.

## Approaches

- **A. Logo assembles with the progress.** Ties the animation to the %, but the maintainer preferred a free loop.
- **B. Decorative loop with hover and click (picked).** Slow rotation; hover highlights a piece; click detaches it, it floats away, then returns.

## Design

- An overlay over the Generate viewer, shown only while `currentJob.status` is `uploading` or `generating`. The scene behind is dimmed; `GenerationHUD` stays on top at the bottom. The overlay captures the pointer (no orbiting the scene meanwhile).
- Its own `@react-three/fiber` canvas, transparent background. The three pieces are the three paths of `src/shared/components/ui/ModlyLogo.tsx`, parsed (e.g. three's `SVGLoader`), centered, extruded thin.
- Look: violet wireframe with a visible triangulated mesh and small vertex dots, a soft glow, as in the reference image (dark background, `#c084fc` to `#9333ea` palette).
- Idle: the logo rotates slowly around the vertical axis.
- Hover: the hovered piece lights up (brighter violet fill and edges), cursor becomes a pointer.
- Click: the piece moves outward from the logo center (with a slight tilt) and leaves a short trail of particles, holds briefly, then returns and snaps back; total about 1.5 s. Clicks during its flight are ignored for that piece.
- End: the overlay fades out when the job leaves `uploading`/`generating`.
- `prefers-reduced-motion`: no rotation, no float-away; hover highlight stays.

## Left to the builder

Exact geometry (extrude depth, how the face is triangulated for the wireframe look), easing curves, glow technique (postprocessing bloom or additive materials), file layout under `src/areas/generate/components/`.
