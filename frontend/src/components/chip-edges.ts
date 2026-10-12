/** Which edges of a chip row hide more chips: there the row fades out. */
export type ChipEdges = { start: boolean; end: boolean }

/**
 * The fades of a horizontal scroller from its scroll position (pixels, as the browser reports them).
 * A pixel of slack on either side counts as the edge: zoom and fractional widths leave such remainders.
 */
export function chipEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): ChipEdges {
  const position = Math.abs(scrollLeft)
  const rest = scrollWidth - clientWidth - position
  return { start: position > 1, end: rest > 1 }
}
