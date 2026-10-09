import type { FormEvent, Ref } from 'react'
import type { MergeGroup, MergeMember } from '../../api/product-merges'
import { useNarrow } from '../../lib/cards'
import { formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import { Link } from '../../navigation'
import type { ActionState } from './actions'
import { factValue, fieldLabels, hasFact, memberName, periodJoint, statusLabels } from './labels'
import MergeMemberCards from './MergeMemberCards'
import type { MergeMemberColumns } from './MergeMemberCards'
import { activeMembers, canConfirm, conflictOptions, missingResolutions, refusedFields, selectName, selectResolution, selectTarget } from './state'
import type { MergeSelection } from './state'

/** Absorbed records answer 404 in the catalog until the group is cancelled; deleted ones never return. */
function hasCard(group: MergeGroup, member: MergeMember): boolean {
  return member.exists && (group.status !== 'pending' || member.state === 'excluded' || member.product_id === group.target_product_id)
}

const facts = ['generic', 'brand', 'package', 'gtin', 'model'] as const

/** Column headings: the table and the cards of a phone read the same texts. */
const columns: MergeMemberColumns = {
  target: 'Оставляемая запись', name: 'Название', aliases: 'Написания в чеках', lines: 'Покупок', dates: 'Даты покупок', facts: 'Факты', action: 'Действие',
}

const day = (value: string) => <time dateTime={value}>{formatPurchasedOn(value)}</time>

/** First and last purchase of a record: one date, or a period that never starts a line with its dash. */
function PurchaseDates({ member }: { member: MergeMember }) {
  if (member.first_purchased_on === null) return 'Нет покупок'
  if (member.last_purchased_on === null || member.first_purchased_on === member.last_purchased_on) return day(member.first_purchased_on)
  return <>{day(member.first_purchased_on)}{periodJoint}{day(member.last_purchased_on)}</>
}

function MemberRow({ group, member, selection, busy, excluding, onSelection, onExclude }: {
  group: MergeGroup; member: MergeMember; selection: MergeSelection; busy: boolean; excluding: boolean
  onSelection: (selection: MergeSelection) => void; onExclude: (productId: number) => void
}) {
  const pending = group.status === 'pending'
  const active = member.state === 'active'
  const name = memberName(member)
  return <tr>
    {pending && <td className="ck-merge-whole">{active && <label className="ck-merge-choice">
      <input type="radio" name="merge-target" value={member.product_id} checked={selection.target === member.product_id}
        disabled={busy || !group.actions.can_confirm} onChange={() => onSelection(selectTarget(selection, member.product_id))} />
      <span>Оставить<span className="ck-merge-hidden"> запись №{member.product_id}: {name}</span></span>
    </label>}</td>}
    <th scope="row">
      {hasCard(group, member) ? <Link to={{ kind: 'product', productId: member.product_id, query: { page: 1 } }}>{name}</Link> : name}
      <span className="ck-merge-subtext">{numbered('Запись', member.product_id)}
        {!active ? ' · исключена из группы' : !member.exists ? ' · удалена после слияния'
          : member.product_id === group.target_product_id ? (pending ? ' · оставляемая по умолчанию' : ' · оставленный товар') : ''}</span>
    </th>
    <td className="ck-merge-text">{member.aliases.length === 0 ? '—' : <ul className="ck-merge-cell-list">{member.aliases.map((alias, index) =>
      <li key={`${alias.store_name}/${alias.raw_name}/${alias.store_item_code}/${index}`}>{alias.raw_name}
        <span className="ck-merge-subtext">{alias.store_name.trim() || 'Магазин не указан'}{alias.store_item_code && ` · код ${alias.store_item_code}`}</span></li>)}</ul>}</td>
    <td className="ck-merge-number">{member.lines_count.toLocaleString('ru-RU')}</td>
    <td className="ck-merge-whole"><PurchaseDates member={member} /></td>
    <td className="ck-merge-text"><dl className="ck-merge-cell-facts">
      {facts.filter((field) => field === 'generic' || hasFact(member, field)).map((field) => <div key={field}><dt>{fieldLabels[field]}</dt><dd>{factValue(member, field)}</dd></div>)}
    </dl></td>
    {pending && <td>{active && group.actions.can_exclude && <button type="button" className="ck-merge-secondary" disabled={busy}
      aria-label={`Исключить из группы запись №${member.product_id}: ${name}`} onClick={() => onExclude(member.product_id)}>
      {excluding ? 'Исключаем…' : 'Исключить из группы'}</button>}</td>}
  </tr>
}

/** Records of a group with the person's choice and the three actions. Pure markup: requests live in MergePage. */
export default function MergeGroupView({ group, selection, action, onSelection, onConfirm, onCancel, onExclude, resultRef }: {
  group: MergeGroup; selection: MergeSelection; action: ActionState
  onSelection: (selection: MergeSelection) => void; onConfirm: () => void; onCancel: () => void; onExclude: (productId: number) => void
  resultRef?: Ref<HTMLParagraphElement>
}) {
  const narrow = useNarrow()
  const pending = group.status === 'pending'
  const busy = action.kind === 'pending'
  const running = busy ? action.action : undefined
  const active = activeMembers(group.members)
  const target = active.find((member) => member.product_id === selection.target)
  const missing = missingResolutions(group, selection)
  const refused = refusedFields(action.kind === 'failed' ? action.error : undefined)
  const confirmable = canConfirm(group, selection)
  const failedAction = action.kind === 'failed' && action.error.reason === 'merge_busy' ? action.action : undefined
  const retry = failedAction?.type === 'confirm' ? onConfirm : failedAction?.type === 'cancel' ? onCancel
    : failedAction?.type === 'exclude' ? () => onExclude(failedAction.input.product_id) : undefined
  const caption = pending ? 'Выберите запись, которая останется товаром каталога. Счётчики и написания показаны по исходной принадлежности.' : 'Записи группы на момент завершения.'
  const submit = (event: FormEvent) => { event.preventDefault(); if (confirmable && !busy) onConfirm() }
  return <section className="ck-merge-panel" aria-labelledby="merge-members-title">
    <h2 id="merge-members-title">Записи группы</h2>
    <form className="ck-merge-form" noValidate onSubmit={submit}>
      {narrow ? <MergeMemberCards group={group} columns={columns} caption={caption} labelledBy="merge-members-title" selection={selection} busy={busy}
        excludingId={running?.type === 'exclude' ? running.input.product_id : undefined} onSelection={onSelection} onExclude={onExclude} />
      : <div className="ck-merge-table-scroll" role="region" aria-label="Таблица записей группы, прокручивается по горизонтали" tabIndex={0}>
        <table className={`ck-merge-table ck-merge-members${pending ? ' ck-merge-choosing' : ''}`}>
          <caption>{caption}</caption>
          <thead><tr>
            {pending && <th scope="col">{columns.target}</th>}
            <th scope="col" className="ck-merge-name-head">{columns.name}</th><th scope="col">{columns.aliases}</th><th scope="col">{columns.lines}</th>
            <th scope="col">{columns.dates}</th><th scope="col">{columns.facts}</th>
            {pending && <th scope="col">{columns.action}</th>}
          </tr></thead>
          <tbody>{group.members.map((member) => <MemberRow key={member.product_id} group={group} member={member} selection={selection} busy={busy}
            excluding={running?.type === 'exclude' && running.input.product_id === member.product_id} onSelection={onSelection} onExclude={onExclude} />)}</tbody>
        </table>
      </div>}
      {pending && group.actions.can_confirm && <>
        <div className="ck-merge-field">
          <label htmlFor="merge-name">Название оставляемого товара</label>
          <select id="merge-name" value={selection.name ?? ''} disabled={busy} aria-invalid={refused.includes('name')} aria-describedby="merge-name-note"
            onChange={(event) => onSelection(selectName(selection, event.target.value ? Number(event.target.value) : undefined))}>
            <option value="">Не менять: «{target ? memberName(target) : 'Не указано'}»</option>
            {active.filter((member) => member.product_id !== selection.target).map((member) =>
              <option value={member.product_id} key={member.product_id}>Взять из записи №{member.product_id}: «{memberName(member)}»</option>)}
          </select>
          <p className="ck-merge-note" id="merge-name-note">Название меняется только по вашему выбору. Произвольный текст задаётся в админке.</p>
        </div>
        {group.conflicts.length > 0 && <div className="ck-merge-conflicts">
          <p className="ck-merge-warning">У записей разные значения. Выберите, какое останется у товара: без выбора подтверждение недоступно.</p>
          {group.conflicts.map((conflict) => {
            const invalid = refused.includes(conflict.field) && missing.includes(conflict.field)
            const errorId = `merge-resolution-${conflict.field}-error`
            return <fieldset key={conflict.field} role="radiogroup" aria-required="true" aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined} className={invalid ? 'ck-merge-invalid' : undefined}>
              <legend>{fieldLabels[conflict.field]}</legend>
              {conflictOptions(group, conflict).map((member) => <label className="ck-merge-choice" key={member.product_id}>
                <input type="radio" name={`merge-resolution-${conflict.field}`} value={member.product_id} disabled={busy}
                  checked={selection.resolutions[conflict.field] === member.product_id}
                  onChange={() => onSelection(selectResolution(selection, conflict.field, member.product_id))} />
                <span>{factValue(member, conflict.field)}<span className="ck-merge-subtext">из записи №{member.product_id}: {memberName(member)}</span></span>
              </label>)}
              {invalid && <p className="ck-merge-error" id={errorId}>Сервер отклонил подтверждение: выберите значение этого поля.</p>}
            </fieldset>
          })}
        </div>}
        <p className="ck-merge-note" id="merge-confirm-note">{missing.length > 0
          ? `Чтобы подтвердить, выберите значение: ${missing.map((field) => fieldLabels[field].toLocaleLowerCase('ru-RU')).join(', ')}.`
          : 'Подтверждение необратимо: остальные записи будут удалены, их покупки и написания останутся у выбранного товара.'}</p>
      </>}
      {pending && <div className="ck-merge-actions">
        {group.actions.can_confirm && <button type="submit" disabled={busy || !confirmable} aria-describedby="merge-confirm-note">{running?.type === 'confirm' ? 'Подтверждаем…' : 'Подтвердить слияние'}</button>}
        {group.actions.can_cancel && <button type="button" className="ck-merge-secondary" disabled={busy} onClick={onCancel}>{running?.type === 'cancel' ? 'Отменяем…' : 'Отменить слияние'}</button>}
      </div>}
    </form>
    {!pending && <p className={`ck-merge-status ck-merge-status-${group.status}`}>{statusLabels[group.status]}: действия с группой больше недоступны.</p>}
    <p ref={resultRef} tabIndex={-1} role="status" aria-live="polite" className={action.kind === 'failed' ? 'ck-merge-error' : 'ck-merge-result'}>
      {action.kind === 'done' || action.kind === 'failed' ? action.message : ''}
    </p>
    {retry && pending && <div className="ck-merge-actions"><button type="button" className="ck-merge-secondary" onClick={retry}>Повторить</button></div>}
  </section>
}
