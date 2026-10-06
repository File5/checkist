/** Selection and keyboard logic of the charts as pure reducers: tested in Node, used by the components. */
import { coordinate } from './scale.ts'

/* Pie: the sector and its legend row are highlighted together, by pointer or by focus. */

export interface PieHighlight { hovered: string | null; focused: string | null }
export type PieHighlightAction =
  | { type: 'enter' | 'focus'; key: string }
  | { type: 'leave' | 'blur'; key: string }

export const noPieHighlight: PieHighlight = { hovered: null, focused: null }

export function pieHighlightReducer(state: PieHighlight, action: PieHighlightAction): PieHighlight {
  switch (action.type) {
    case 'enter': return state.hovered === action.key ? state : { ...state, hovered: action.key }
    case 'focus': return state.focused === action.key ? state : { ...state, focused: action.key }
    // A late leave/blur of an element that is no longer the current one must not clear its successor.
    case 'leave': return state.hovered === action.key ? { ...state, hovered: null } : state
    case 'blur': return state.focused === action.key ? { ...state, focused: null } : state
  }
}

/** The pointer is the more recent and more precise intent; focus stays as the fallback. */
export function activePieKey(state: PieHighlight, keys: readonly string[]): string | null {
  const known = (key: string | null) => (key !== null && keys.includes(key) ? key : null)
  return known(state.hovered) ?? known(state.focused)
}

/* Line: one selected period (by its start date, so it survives a change of the visible series). */

export interface LineSelection {
  /** `period_start` of the selected interval. */
  activeX: string | null
  /** `touch`: a finger has no hover, so the point it tapped stays selected after it lifts. */
  source: 'keyboard' | 'pointer' | 'touch' | null
  /** Keys of the series switched off in the legend. */
  hidden: readonly string[]
}
export type LineKeyCommand = 'previous' | 'next' | 'first' | 'last' | 'clear'
export type LineSelectionAction =
  | { type: 'key'; command: LineKeyCommand; xs: readonly string[] }
  | { type: 'pointer'; x: string | null; touch?: boolean }
  | { type: 'pointer-leave' }
  | { type: 'blur' }
  | { type: 'toggle'; key: string }

export function initialLineSelection(hidden: readonly string[] = []): LineSelection {
  return { activeX: null, source: null, hidden: [...new Set(hidden)] }
}

/** Keys the plot area handles; anything else is left to the browser. */
export function lineKeyCommand(key: string): LineKeyCommand | null {
  switch (key) {
    case 'ArrowLeft': return 'previous'
    case 'ArrowRight': return 'next'
    case 'Home': return 'first'
    case 'End': return 'last'
    case 'Escape': return 'clear'
    default: return null
  }
}

/** Target of a keyboard step. Without a selection ← starts from the last interval and → from the first. */
export function stepLineSelection(activeX: string | null, command: LineKeyCommand, xs: readonly string[]): string | null {
  if (command === 'clear' || xs.length === 0) return null
  if (command === 'first') return xs[0]
  if (command === 'last') return xs[xs.length - 1]
  const current = activeX === null ? -1 : xs.indexOf(activeX)
  if (current === -1) return command === 'next' ? xs[0] : xs[xs.length - 1]
  const next = command === 'next' ? Math.min(xs.length - 1, current + 1) : Math.max(0, current - 1)
  return xs[next]
}

const cleared = (state: LineSelection): LineSelection =>
  state.activeX === null && state.source === null ? state : { ...state, activeX: null, source: null }

export function lineSelectionReducer(state: LineSelection, action: LineSelectionAction): LineSelection {
  switch (action.type) {
    case 'key': {
      const activeX = stepLineSelection(state.activeX, action.command, action.xs)
      return activeX === null ? cleared(state) : { ...state, activeX, source: 'keyboard' }
    }
    case 'pointer': {
      if (action.x === null) return state
      const source = action.touch ? 'touch' : 'pointer'
      return state.activeX === action.x && state.source === source ? state : { ...state, activeX: action.x, source }
    }
    // The pointer leaving must not drop a selection the keyboard owns, and vice versa. A lifted finger also
    // "leaves": its selection stays until another tap, Escape or the focus moving away.
    case 'pointer-leave': return state.source === 'pointer' ? cleared(state) : state
    case 'blur': return state.source === 'keyboard' || state.source === 'touch' ? cleared(state) : state
    case 'toggle': {
      const hidden = state.hidden.includes(action.key) ? state.hidden.filter((key) => key !== action.key) : [...state.hidden, action.key]
      return { ...state, hidden }
    }
  }
}

export interface LineTooltipAnchor { side: 'left' | 'right'; style: { left: string } | { right: string } }

/** Where the tooltip hangs: on the roomier side of the crosshair and anchored by the plot edge of that side, so
    the room left for its shrink-to-fit width is the room on that side — at least half of the plot. */
export function lineTooltipAnchor(position: number, width: number): LineTooltipAnchor {
  const share = Math.min(100, Math.max(0, (position / width) * 100))
  return share > 50 ? { side: 'left', style: { right: `${coordinate(100 - share)}%` } } : { side: 'right', style: { left: `${coordinate(share)}%` } }
}

/** The selection only counts while its interval exists among the visible series. */
export function activeLineX(state: LineSelection, xs: readonly string[]): string | null {
  return state.activeX !== null && xs.includes(state.activeX) ? state.activeX : null
}

export interface LineReadoutSeries { label: string; values: ReadonlyMap<string, string> }

/** The text of the `aria-live` line: the interval and every visible series that has a value in it. */
export function lineReadout(x: string | null, series: readonly LineReadoutSeries[], formatX: (x: string) => string): string {
  if (x === null) return ''
  const parts = series.flatMap((item) => {
    const value = item.values.get(x)
    return value === undefined ? [] : [`${item.label} — ${value}`]
  })
  return `${formatX(x)}: ${parts.length ? parts.join('; ') : 'нет данных'}`
}
