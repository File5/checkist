import type { ReactNode } from 'react'
import type { MergeGroup, MergeMember } from '../../api/product-merges'
import { Card, CardList } from '../../lib/cards'
import type { CardFact } from '../../lib/cards'
import { formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import { Link } from '../../navigation'
import { factValue, fieldLabels, hasFact, memberName, periodJoint } from './labels'
import { selectTarget } from './state'
import type { MergeSelection } from './state'

/** Headings of the table of records: the table and the cards read the same texts. */
export interface MergeMemberColumns { target: string; name: string; aliases: string; lines: string; dates: string; facts: string; action: string }

const facts = ['generic', 'brand', 'package', 'gtin', 'model'] as const

const day = (value: string) => <time dateTime={value}>{formatPurchasedOn(value)}</time>

/** Absorbed records answer 404 in the catalog until the group is cancelled; deleted ones never return. */
function hasCard(group: MergeGroup, member: MergeMember): boolean {
  return member.exists && (group.status !== 'pending' || member.state === 'excluded' || member.product_id === group.target_product_id)
}

function purchaseDates(member: MergeMember): ReactNode {
  if (member.first_purchased_on === null) return 'Нет покупок'
  if (member.last_purchased_on === null || member.first_purchased_on === member.last_purchased_on) return day(member.first_purchased_on)
  return <>{day(member.first_purchased_on)}{periodJoint}{day(member.last_purchased_on)}</>
}

/**
 * The phone view of the records of a group: every cell of a table row becomes a fact under the heading of its column.
 * The radio and the button are the same controls with the same handlers; the choice itself lives in MergePage.
 */
export default function MergeMemberCards({ group, columns, caption, labelledBy, selection, busy, excludingId, onSelection, onExclude }: {
  group: MergeGroup; columns: MergeMemberColumns; caption: string; labelledBy: string; selection: MergeSelection; busy: boolean
  excludingId: number | undefined; onSelection: (selection: MergeSelection) => void; onExclude: (productId: number) => void
}) {
  const pending = group.status === 'pending'
  return <CardList labelledBy={labelledBy} caption={caption}>
    {group.members.map((member) => {
      const active = member.state === 'active'
      const name = memberName(member)
      const cells: CardFact[] = [
        { key: 'target', label: columns.target, value: pending && active && <label className="ck-merge-choice">
          <input type="radio" name="merge-target" value={member.product_id} checked={selection.target === member.product_id}
            disabled={busy || !group.actions.can_confirm} onChange={() => onSelection(selectTarget(selection, member.product_id))} />
          <span>Оставить<span className="ck-merge-hidden"> запись №{member.product_id}: {name}</span></span>
        </label> },
        member.aliases.length === 0 ? { key: 'aliases', label: columns.aliases, value: '—' }
          : { key: 'aliases', label: columns.aliases, kind: 'block', value: <ul className="ck-merge-cell-list">{member.aliases.map((alias, index) =>
            <li key={`${alias.store_name}/${alias.raw_name}/${alias.store_item_code}/${index}`}>{alias.raw_name}
              <span className="ck-merge-subtext">{alias.store_name.trim() || 'Магазин не указан'}{alias.store_item_code && ` · код ${alias.store_item_code}`}</span></li>)}</ul> },
        { key: 'lines', label: columns.lines, value: member.lines_count.toLocaleString('ru-RU') },
        { key: 'dates', label: columns.dates, value: purchaseDates(member) },
        { key: 'facts', label: columns.facts, kind: 'block', value: <dl className="ck-merge-cell-facts">
          {facts.filter((field) => field === 'generic' || hasFact(member, field)).map((field) => <div key={field}><dt>{fieldLabels[field]}</dt><dd>{factValue(member, field)}</dd></div>)}
        </dl> },
        { key: 'action', label: columns.action, value: pending && active && group.actions.can_exclude && <button type="button" className="ck-merge-secondary" disabled={busy}
          aria-label={`Исключить из группы запись №${member.product_id}: ${name}`} onClick={() => onExclude(member.product_id)}>
          {excludingId === member.product_id ? 'Исключаем…' : 'Исключить из группы'}</button> },
      ]
      return <Card key={member.product_id} facts={cells} title={<>
        {hasCard(group, member) ? <Link to={{ kind: 'product', productId: member.product_id, query: { page: 1 } }}>{name}</Link> : name}
        <span className="ck-merge-subtext">{numbered('Запись', member.product_id)}
          {!active ? ' · исключена из группы' : !member.exists ? ' · удалена после слияния'
            : member.product_id === group.target_product_id ? (pending ? ' · оставляемая по умолчанию' : ' · оставленный товар') : ''}</span>
      </>} />
    })}
  </CardList>
}
