/**
 * Combine a step's own art direction with the free text an artist typed into
 * "Extra details".
 *
 * The note ADDS TO the direction; it never replaces it. This used to replace
 * it, silently, and it was expensive: choosing a Creature style and then asking
 * to keep one tentacle short deleted every word about being a photographic
 * creature, so the generator was handed a cropped notebook drawing and
 * faithfully rebuilt it as a flat card. Weeks of the flatness were blamed on
 * resolution and mesh budgets; the cause was this line.
 *
 * `base` is unknown rather than string because it comes from a params bag that
 * may hold anything, or nothing at all — a Custom style deliberately carries an
 * empty prompt so the artist's own words are the whole direction.
 */
export function mergeNodeText(base: unknown, added: unknown): string {
  const direction = typeof base === 'string' ? base.trim() : ''
  const note = typeof added === 'string' ? added.trim() : ''
  if (!note) return direction
  if (!direction) return note
  // Already said — don't stutter it back at the generator. Keep the DIRECTION,
  // which is the longer text: collapsing to the note here would throw away the
  // style again, which is the whole failure this function exists to prevent.
  if (direction === note || direction.includes(note)) return direction
  return `${direction.replace(/[.\s]+$/, '')}. ${note}`
}
