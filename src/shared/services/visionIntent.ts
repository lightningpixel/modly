/**
 * Whether a chat turn asks the assistant to LOOK at the attached picture,
 * rather than just carrying one along.
 *
 * Attaching an image used to swap the chat model for the largest downloaded
 * vision model every time. But "transforme cette image en 3D" needs no eyes at
 * all: the bytes go straight to the generator as workflow input, and the swap
 * only traded a 4B model for an 8B one — slower, heavier on a card that also
 * has to hold the 3D pipeline, and weaker at tool calling, which is the part
 * that request actually depends on.
 *
 * Matched on the verb, in the two languages the app is used in. A turn that
 * matches nothing keeps the selected model, and its image still reaches the run.
 */
const LOOK_AT_IMAGE =
  /\b(?:look|see|read|describ\w*|identif\w*|recogni\w*|analys\w*|analyz\w*)\b|\bwhat(?:'s|\s+(?:is|are|can\s+you\s+see))\b|\b(?:regarde\w*|vois|voir|décri\w*|decri\w*|identifi\w*|reconna\w*|lis|lire)\b|\bqu['’e]\s*(?:est-ce|y\s+a-t-il|vois)\b/i

export function wantsToSeeTheImage(text: string): boolean {
  return LOOK_AT_IMAGE.test(text)
}
