import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Close a popover when the pointer goes down anywhere outside `ref`.
 *
 * Every dropdown in the app was carrying its own copy of this effect, which is
 * how they drifted: `mousedown` rather than `click` matters (a click that starts
 * inside and ends outside must not close), and the listener has to be detached
 * while the popover is shut or every menu in the tree handles every click.
 *
 * `onClose` is read through a ref, so callers can pass an inline arrow without
 * the listener being torn down and re-attached on every render.
 */
export function useOutsideClick(
  ref:     RefObject<HTMLElement | null>,
  open:    boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, open])
}
