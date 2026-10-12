import type { ReceiptListItem } from '../../api/receipts'
import { Link } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { categoryTone, groupByDay, rowMeta, rowTitle, withOwner } from './spends'
import type { OwnerChip } from './spends'
import { money } from './state'
import ChipScroller from '../../components/ChipScroller'

/** A photo receipt: a slip with a torn edge. */
const receiptIcon = 'M5 2h10v16l-2-1.3-1.7 1.3L10 16.7 8.7 18 7 16.7 5 18Zm2.5 4v1.5h5V6Zm0 3.5V11h5V9.5Zm0 3.5v1.5h3V13Z'
/** A spend entered by hand: a pencil. */
const pencilIcon = 'm13.6 2.6 3.8 3.8-9.9 9.9-4.6.8.8-4.6Zm0 2.3-7.9 7.9-.4 2 2-.4 7.9-7.9Z'

function SpendRow({ receipt, showOwner }: { receipt: ReceiptListItem; showOwner: boolean }) {
  const tone = receipt.category ? categoryTone(receipt.category.id) : undefined
  const manual = receipt.source === 'manual'
  return <li>
    <Link className="spends-row" to={`/receipts/${receipt.id}`}>
      <span className="spends-badge" data-tone={tone} aria-hidden="true">
        <svg viewBox="0 0 20 20" width="20" height="20" focusable="false"><path d={manual ? pencilIcon : receiptIcon} /></svg>
      </span>
      <span className="spends-row-main">
        <span className="spends-row-title">{rowTitle(receipt)}{manual && <span className="spends-hidden"> (трата без чека)</span>}</span>
        <span className="spends-row-meta">{rowMeta(receipt, showOwner).join(' · ')}</span>
      </span>
      <span className="spends-row-amount ck-figures">{money(receipt.total, receipt.currency)}</span>
    </Link>
  </li>
}

/** The phone view of «Траты»: days with their totals, one strip of receipt tape per day, one row per receipt. The day
 * heading with its total stays at the top of the screen while its rows scroll. */
export function SpendDays({ receipts, today, showOwner }: { receipts: ReceiptListItem[]; today: string; showOwner: boolean }) {
  return <div className="spends-days">{groupByDay(receipts, today).map((day) => <section key={day.day} className="spends-day" aria-label={day.label}>
    <div className="spends-day-head">
      <h3><time dateTime={day.day}>{day.label}</time></h3>
      <p className="spends-day-total">{day.totals.map((item, index) => <span key={item.currency}>
        {index > 0 && ' · '}<span className="spends-day-sum ck-figures">{money(item.total, item.currency)}</span>
      </span>)}</p>
    </div>
    <ul className="spends-rows ck-tape">{day.receipts.map((receipt) => <SpendRow key={receipt.id} receipt={receipt} showOwner={showOwner} />)}</ul>
  </section>)}</div>
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
