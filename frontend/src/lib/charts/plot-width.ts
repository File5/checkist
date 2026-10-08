import { useEffect, useState } from 'react'

export interface PlotWidthLimits {
  /** Width until the first measurement, and where there is nothing to measure with (server markup). */
  fallback: number
  min: number
  max: number
}

/**
 * Follows the real width of the element the returned ref is put on. A drawing whose viewBox has this width is shown
 * one to one, so its text keeps its size on a narrow screen instead of shrinking with the viewBox.
 * The ref is a callback: an element that appears later than its chart (the first data after an empty answer) is
 * measured as well.
 */
export function usePlotWidth<T extends HTMLElement>({ fallback, min, max }: PlotWidthLimits) {
  const [node, ref] = useState<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      if (next > 0) setWidth(Math.min(max, Math.max(min, Math.round(next))))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, min, max])
  return [ref, width] as const
}
