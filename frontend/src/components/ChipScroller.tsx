import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { chipEdges } from './chip-edges'
import type { ChipEdges } from './chip-edges'
import './ChipScroller.css'

export interface ChipScrollerProps {
  /** The name of the row for a screen reader and of its scroll region («Месяцы», «Активные фильтры»). */
  label: string
  /** Chips: links or buttons, usually with the `ck-chip` class. They stand in one row and never wrap. */
  children: ReactNode
  className?: string
}

/**
 * One row of chips that scrolls sideways, with fades at the edges that hide more chips.
 * The row itself takes the focus (Tab, then the arrow keys scroll it), and so does every chip in it;
 * a focused chip is scrolled into view by the browser.
 */
export default function ChipScroller({ label, children, className }: ChipScrollerProps) {
  const track = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<ChipEdges>({ start: false, end: false })

  useEffect(() => {
    const node = track.current
    if (!node) return
    const measure = () => {
      const next = chipEdges(node.scrollLeft, node.clientWidth, node.scrollWidth)
      setEdges((current) => current.start === next.start && current.end === next.end ? current : next)
    }
    measure()
    node.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      node.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [children])

  return (
    <div className={className ? `ck-chip-scroller ${className}` : 'ck-chip-scroller'}
      data-fade-start={edges.start ? '' : undefined} data-fade-end={edges.end ? '' : undefined}>
      <div className="ck-chip-scroller-track" ref={track} role="region" aria-label={label} tabIndex={0}>
        {children}
      </div>
    </div>
  )
}
