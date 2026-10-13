import type { ReceiptListItem } from '../../api/receipts'
import { Link } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { categoryTone, groupByDay, isRowFlag, rowMeta, rowTitle, spendSource, withHidden, withOwner } from './spends'
import type { OwnerChip, SpendSource } from './spends'
import { money } from './state'
import { baseTwin } from '../../lib/money'
import ChipScroller from '../../components/ChipScroller'

/** The badge of a row: a slip of a photo receipt, a pencil of a spend typed by hand, a card of a bank statement. Strokes of
 * the 24px grid, the colour of the category. */
const sourceIcons: Record<SpendSource, string[]> = {
  photo: ['M6 2h12v20l-3-2-3 2-3-2-3 2z', 'M9 7h6M9 11h6M9 15h4'],
  manual: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  statement: ['M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M2 10h20M6 15h4'],
}
/** What the badge says, for a screen reader: it is hidden from it. */
const sourceWords: Record<SpendSource, string> = { photo: ' (по чеку)', manual: ' (трата без чека)', statement: ' (из выписки)' }

export function SourceIcon({ source }: { source: SpendSource }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" focusable="false" data-source={source}>
    {sourceIcons[source].map((d) => <path key={d} d={d} />)}
  </svg>
}

/** «≈ 8 979 ₸» under «20 $»: a spend in another currency keeps its own amount, the totals count this converted one. */
export function BaseTwin({ receipt }: { receipt: Pick<ReceiptListItem, 'currency' | 'base_total' | 'base_currency'> }) {
  const twin = baseTwin(receipt.currency, receipt.base_total, receipt.base_currency)
  return twin ? <span className="spends-row-twin">{twin}</span> : null
}

function SpendRow({ receipt, showOwner }: { receipt: ReceiptListItem; showOwner: boolean }) {
  const tone = receipt.category ? categoryTone(receipt.category.id) : undefined
  const source = spendSource(receipt)
  return <li>
    <Link className="spends-row" to={`/receipts/${receipt.id}`} data-hidden={receipt.hidden ? '' : undefined}>
      <span className="spends-badge" data-tone={tone} aria-hidden="true"><SourceIcon source={source} /></span>
      <span className="spends-row-main">
        <span className="spends-row-title">{rowTitle(receipt)}<span className="spends-hidden">{sourceWords[source]}</span></span>
        <span className="spends-row-meta">{rowMeta(receipt, showOwner).map((text, index) => <span key={index} className={isRowFlag(text) ? 'spends-row-flag' : undefined}>
          {index > 0 && ' · '}{text}</span>)}</span>
      </span>
      <span className="spends-row-amount ck-figures">{money(receipt.total, receipt.currency)}
        <BaseTwin receipt={receipt} /></span>
    </Link>
  </li>
}

/** «Траты» like the mockup, on a phone and in the column of a wide screen: a day — its name and its total in a quiet line, then one card with a row
 * per receipt (a badge by the source in the colour of the category, the place, who and on what, the amount). */
export function SpendDays({ receipts, today, showOwner }: { receipts: ReceiptListItem[]; today: string; showOwner: boolean }) {
  return <div className="spends-days">{groupByDay(receipts, today).map((day) => <section key={day.day} className="spends-day" aria-label={day.label}>
    <div className="spends-day-head">
      <h3><time dateTime={day.day}>{day.label}</time></h3>
      <p className="spends-day-total">{day.totals.map((item, index) => <span key={item.currency}>
        {index > 0 && ' · '}<span className="spends-day-sum ck-figures">{money(item.total, item.currency)}</span>
      </span>)}</p>
    </div>
    <ul className="spends-rows">{day.receipts.map((receipt) => <SpendRow key={receipt.id} receipt={receipt} showOwner={showOwner} />)}</ul>
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
