// Windowing math for the Library grid: only the rows in (or near) the viewport
// are rendered, so a large library scrolls at a constant cost.

export interface GridLayoutOptions {
  /** Content width available to the rows, in px. */
  width: number
  itemCount: number
  gap: number
  /** Narrowest a column may get; columns stretch to fill the width. */
  minColumnWidth: number
  /** Fixed row height; when absent rows are square tiles plus `labelHeight`. */
  rowHeight?: number
  labelHeight?: number
}

export interface GridLayout {
  columns: number
  columnWidth: number
  rowHeight: number
  /** Row height plus the gap below it. */
  rowStride: number
  rowCount: number
  totalHeight: number
}

export function computeGridLayout(options: GridLayoutOptions): GridLayout {
  const width = Math.max(0, options.width)
  const gap = Math.max(0, options.gap)
  const columns = Math.max(1, Math.floor((width + gap) / (Math.max(1, options.minColumnWidth) + gap)))
  const columnWidth = Math.max(0, Math.floor((width - gap * (columns - 1)) / columns))
  const rowHeight = options.rowHeight ?? columnWidth + (options.labelHeight ?? 0)
  const rowCount = Math.ceil(Math.max(0, options.itemCount) / columns)
  const rowStride = rowHeight + gap
  const totalHeight = rowCount === 0 ? 0 : rowCount * rowHeight + (rowCount - 1) * gap
  return { columns, columnWidth, rowHeight, rowStride, rowCount, totalHeight }
}

export interface RowRange {
  /** First row to render. */
  start: number
  /** One past the last row to render. */
  end: number
}

/** Rows intersecting the viewport, plus `overscan` rows on each side. */
export function visibleRowRange(layout: Pick<GridLayout, 'rowStride' | 'rowCount'>, scrollTop: number, viewportHeight: number, overscan = 2): RowRange {
  if (layout.rowCount === 0 || layout.rowStride <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, scrollTop)
  const first = Math.min(layout.rowCount - 1, Math.floor(top / layout.rowStride))
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / layout.rowStride)
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(layout.rowCount, Math.max(first + 1, last) + overscan),
  }
}

/** The scrollTop that brings a row fully into view, or null when it already is. */
export function scrollTopToReveal(layout: Pick<GridLayout, 'rowStride' | 'rowHeight'>, row: number, scrollTop: number, viewportHeight: number): number | null {
  const top = row * layout.rowStride
  const bottom = top + layout.rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight)
  return null
}

/** Arrow-key movement through a grid of `count` items laid out in `columns`. */
export function moveGridIndex(index: number, key: string, columns: number, count: number): number | null {
  if (count === 0) return null
  if (index < 0) return 0
  const next = key === 'ArrowRight' ? index + 1
    : key === 'ArrowLeft' ? index - 1
      : key === 'ArrowDown' ? index + columns
        : key === 'ArrowUp' ? index - columns
          : key === 'Home' ? 0
            : key === 'End' ? count - 1
              : null
  if (next === null) return null
  return Math.min(count - 1, Math.max(0, next))
}
