import { useEffect, useRef } from 'react'

/**
 * Where the row of chips has to stand so that the chosen chip is whole in sight: unchanged when it already is,
 * otherwise the chip at the start of the row with a little of the previous one showing. Pure, for the tests.
 */
export function chipScrollLeft(current: number, view: number, chipLeft: number, chipWidth: number, peek = 24): number {
  if (chipLeft >= current && chipLeft + chipWidth <= current + view) return current
  return Math.max(0, chipLeft - peek)
}

/**
 * Keeps the chosen chip of a ChipScroller in sight: «Всё время» at the end of the row is the default and would
 * otherwise stay hidden behind the edge. Put the ref on any element around the scroller; `key` is the chosen chip.
 */
export function useChipInView<T extends HTMLElement>(key: string | undefined) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const track = ref.current?.querySelector<HTMLElement>('.ck-chip-scroller-track')
    const chip = track?.querySelector<HTMLElement>('[aria-current]:not([aria-current="false"])')
    if (!track || !chip) return
    const left = chip.offsetLeft - track.offsetLeft
    const next = chipScrollLeft(track.scrollLeft, track.clientWidth, left, chip.offsetWidth)
    if (next !== track.scrollLeft) track.scrollLeft = next
  }, [key])
  return ref
}
