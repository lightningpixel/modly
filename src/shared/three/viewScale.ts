// How far the Generate viewer's camera, grid and zoom limits are scaled for a
// model. Generated meshes are about a unit across and keep the default view;
// a model at its real size can be a few centimetres (an imported STL, a
// calibrated asset) or many metres, and would otherwise be a speck or swallow
// the camera.

/** Longest sides the default view frames well, in scene units. */
export const DEFAULT_VIEW_RANGE = { min: 0.25, max: 10 } as const

/** The longest side the default view is built around. */
const DEFAULT_VIEW_SIZE = 2

export function viewScaleFor(longestSide: number): number {
  if (!Number.isFinite(longestSide) || longestSide <= 0) return 1
  if (longestSide >= DEFAULT_VIEW_RANGE.min && longestSide <= DEFAULT_VIEW_RANGE.max) return 1
  return longestSide / DEFAULT_VIEW_SIZE
}
