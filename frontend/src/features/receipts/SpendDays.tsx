import { useRef, useState } from 'react'
import type { DragEvent, MouseEvent, PointerEvent } from 'react'
import type { ReceiptListItem } from '../../api/receipts'
import { Link } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { categoryTone, groupByDay, isRowFlag, rowMeta, rowTitle, spendSource, withHidden, withOwner } from './spends'
import type { OwnerChip, SpendSource } from './spends'
import { money } from './state'
import { baseTwin } from '../../lib/money'
import { methodLabels, methodShort } from '../../lib/payment-methods'
import ChipScroller from '../../components/ChipScroller'
import Icon from '../../components/Icon'
import { useSpendIcon } from '../../lib/list-icons'
import { SWIPE_REVEAL, swipeEnd } from './undo-delete'

/** How a spend came in, for a screen reader: the badge is hidden from it and may show the category instead. */
const sourceWords: Record<SpendSource, string> = { photo: ' (по чеку)', manual: ' (трата без чека)', statement: ' (из выписки)' }

/** «≈ 8 979 ₸» under «20 $»: a spend in another currency keeps its own amount, the totals count this converted one. */
export function BaseTwin({ receipt }: { receipt: Pick<ReceiptListItem, 'currency' | 'base_total' | 'base_currency'> }) {
  const twin = baseTwin(receipt.currency, receipt.base_total, receipt.base_currency)
  return twin ? <span className="spends-row-twin">{twin}</span> : null
}

/** Deletes a spend by hand from «Траты»: `keyboard` — by its «Удалить» from a keyboard or a screen reader (a click without a
 * pointer), not by a swipe or a tap: then the focus goes to «Отменить» and the time waits for it. */
export type SpendDelete = (receipt: ReceiptListItem, keyboard: boolean) => void

/** A row that follows a finger (or a mouse) to the left: let go past `swipeEnd` — deleted, past half of the button —
 * open on «Удалить» behind it. A vertical move stays the scroll of the page (`touch-action: pan-y`). A tap after a move
 * does not open the spend; a tap on an open row closes it. */
function useSwipe(onDelete: (() => void) | undefined) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; base: number; pointer: number; active: boolean } | null>(null)
  const moved = useRef(false)
  if (!onDelete) return { style: undefined, handlers: {}, open: false, dragging: false }
  const handlers = {
    onPointerDown(event: PointerEvent<HTMLAnchorElement>) {
      if (event.button !== 0) return
      start.current = { x: event.clientX, y: event.clientY, base: offset, pointer: event.pointerId, active: false }
      moved.current = false
    },
    onPointerMove(event: PointerEvent<HTMLAnchorElement>) {
      const from = start.current
      if (!from || from.pointer !== event.pointerId) return
      const dx = event.clientX - from.x
      const dy = event.clientY - from.y
      if (!from.active) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        if (Math.abs(dy) >= Math.abs(dx)) { start.current = null; return }
        from.active = true
        moved.current = true
        setDragging(true)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      setOffset(Math.min(0, Math.max(-event.currentTarget.offsetWidth, from.base + dx)))
    },
    onPointerUp(event: PointerEvent<HTMLAnchorElement>) {
      const from = start.current
      start.current = null
      if (!from?.active) return
      setDragging(false)
      const end = swipeEnd(offset, event.currentTarget.offsetWidth)
      setOffset(end === 'open' ? -SWIPE_REVEAL : 0)
      if (end === 'delete') onDelete()
    },
    onPointerCancel() {
      const from = start.current
      start.current = null
      setDragging(false)
      if (from) setOffset(from.base)
    },
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      if (moved.current || offset !== 0) event.preventDefault()
      if (!moved.current && offset !== 0) setOffset(0)
      moved.current = false
    },
    onDragStart(event: DragEvent<HTMLAnchorElement>) { event.preventDefault() },
  }
  return { style: offset ? { transform: `translateX(${offset}px)` } : undefined, handlers, open: offset !== 0, dragging }
}

function SpendRow({ receipt, showOwner, onDelete }: { receipt: ReceiptListItem; showOwner: boolean; onDelete?: SpendDelete }) {
  const tone = receipt.category ? categoryTone(receipt.category.id) : undefined
  const source = spendSource(receipt)
  // The badge: the picture of the category (of the only one of the lines, else of their common root) or how the spend
  // came in — the choice of the device (lib/list-icons); its colour is the tone of the category either way.
  const icon = useSpendIcon(source, receipt.categories?.length === 1 ? receipt.categories[0].icon : receipt.category?.icon)
  // Only a spend typed by hand is swiped away: a photo receipt is deleted on its page, with the photo and its checks.
  const deletable = onDelete && receipt.source === 'manual' ? onDelete : undefined
  const swipe = useSwipe(deletable && (() => deletable(receipt, false)))
  const row = <Link className="spends-row" to={`/receipts/${receipt.id}`} data-hidden={receipt.hidden ? '' : undefined}
    style={swipe.style} data-dragging={swipe.dragging ? '' : undefined} {...swipe.handlers}>
      <span className="spends-badge" data-tone={tone} data-icon={icon} aria-hidden="true"><Icon name={icon} size={20} /></span>
      <span className="spends-row-main">
        <span className="spends-row-title">{rowTitle(receipt)}<span className="spends-hidden">{sourceWords[source]}</span></span>
        <span className="spends-row-meta">{rowMeta(receipt, showOwner).map((text, index) => <span key={index} className={isRowFlag(text) ? 'spends-row-flag' : undefined}>
          {index > 0 && ' · '}{text}</span>)}</span>
      </span>
      <span className="spends-row-amount ck-figures">{money(receipt.total, receipt.currency)}
        <BaseTwin receipt={receipt} />
        {/* How it was paid, short and whole under the amount; the full name for a screen reader. */}
        {receipt.payment_method && <span className="spends-row-method"><span aria-hidden="true">{methodShort[receipt.payment_method]}</span>
          <span className="spends-hidden">, {methodLabels[receipt.payment_method]}</span></span>}</span>
    </Link>
  if (!deletable) return <li>{row}</li>
  // «Удалить» lies behind the row: a swipe shows it, the Tab key slides the row aside to it (Receipts.css).
  return <li className="spends-swipe" data-open={swipe.open ? '' : undefined}>
    {row}
    <button type="button" className="spends-row-delete" onClick={(event) => deletable(receipt, event.detail === 0)}>
      <Icon name="trash" size={20} /><span>Удалить<span className="spends-hidden">: {rowTitle(receipt)}</span></span>
    </button>
  </li>
}

/** «Траты» like the mockup, on a phone and in the column of a wide screen: a day — its name and its total in a quiet line, then one card with a row
 * per receipt (a badge in the colour of the category — its picture or the source, the place, who and on what, the amount). */
export function SpendDays({ receipts, today, showOwner, onDelete }: { receipts: ReceiptListItem[]; today: string; showOwner: boolean; onDelete?: SpendDelete }) {
  return <div className="spends-days">{groupByDay(receipts, today).map((day) => <section key={day.day} className="spends-day" aria-label={day.label}>
    <div className="spends-day-head">
      <h3><time dateTime={day.day}>{day.label}</time></h3>
      <p className="spends-day-total">{day.totals.map((item, index) => <span key={item.currency}>
        {index > 0 && ' · '}<span className="spends-day-sum ck-figures">{money(item.total, item.currency)}</span>
      </span>)}</p>
    </div>
    <ul className="spends-rows">{day.receipts.map((receipt) => <SpendRow key={receipt.id} receipt={receipt} showOwner={showOwner} onDelete={onDelete} />)}</ul>
  </section>)}</div>
}

/** The family head's «Показать скрытые»: a pressed chip lists hidden payments too. Nobody else sees it. It stands in the
 * filters (the sheet of a phone); `onToggle` closes the sheet once the list is switched. */
export function HiddenChip({ query, head, onToggle }: { query: ReceiptsQuery; head: boolean; onToggle?: () => void }) {
  if (!head) return null
  const on = query.hidden === 1
  return <div className="spends-chips spends-hidden-toggle">
    <Link className="spends-chip" data-hidden-chip to={{ kind: 'receipts', query: withHidden(query, !on) }} aria-current={on ? 'true' : undefined}
      onClick={onToggle}>
      Показать скрытые
    </Link>
  </div>
}

/** «Вся семья / Андрей / Лиза»: links, so the choice lives in the address; one line that scrolls sideways. */
export function OwnerChips({ chips, query }: { chips: OwnerChip[]; query: ReceiptsQuery }) {
  if (!chips.length) return null
  return <div className="spends-chips">
    <ChipScroller label="Кто добавил">
      <ul>{chips.map((chip) => <li key={chip.owner ?? ''}>
        <Link className="spends-chip" to={{ kind: 'receipts', query: withOwner(query, chip.owner) }} aria-current={chip.current ? 'true' : undefined}>
          {chip.label}
        </Link>
      </li>)}</ul>
    </ChipScroller>
  </div>
}
