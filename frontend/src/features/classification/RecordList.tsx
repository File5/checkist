import type { ReactNode } from 'react'
import type { Classification, ClassificationSuggested } from '../../api/product-classifications'
import { formatObservedAt } from '../../lib/format'
import { Link } from '../../navigation'
import type { ActionState, ClassificationAction } from './actions'
import GenericChooser from './GenericChooser'
import { named, pathSeparator, productFacts, productsCount, statusLabel, unitLabels } from './labels'
import { areaKey, canAct, confirmable, confirmItems, groupRecords } from './state'
import type { OpenArea, SuggestionGroup } from './state'

export type RecordHandlers = {
  onAction: (action: ClassificationAction) => void
  onOpen: (area: OpenArea) => void
  onClose: (area: OpenArea) => void
}
type Shared = RecordHandlers & {
  action: ActionState; open: OpenArea | undefined
  /** The local API is off: nothing can be saved, every action is unavailable. */
  unavailable: boolean
  optionsReload: number
}

/** A product absorbed by a pending duplicate group has no card until the group is decided. */
function ProductName({ record }: { record: Classification }) {
  const { product } = record
  const name = named(product)
  return product.exists && product.merge_group_id === null
    ? <Link to={{ kind: 'product', productId: product.id, query: { page: 1 } }}>{name}</Link> : <>{name}</>
}

export function CategoryPath({ suggested }: { suggested: Pick<ClassificationSuggested, 'category'> }) {
  const path = suggested.category?.path ?? []
  if (path.length === 0) return <>Категория не указана</>
  return <>{path.map((item, index) => <span key={item.id}>
    {index > 0 && pathSeparator}{named(item)}{item.is_new && <> <span className="ck-class-new">новая</span></>}
  </span>)}</>
}

function ProductDetails({ record }: { record: Classification }) {
  const { product } = record
  const facts = productFacts(product)
  return <>
    {product.aliases.length > 0 && <ul className="ck-class-aliases" aria-label={`Написания в чеках: ${named(product)}`}>
      {product.aliases.map((alias, index) => <li key={`${alias.store_name}/${alias.raw_name}/${alias.store_item_code}/${index}`}>
        {alias.raw_name}<span className="ck-class-subtext">{alias.store_name.trim() || 'Магазин не указан'}{alias.store_item_code && ` · код ${alias.store_item_code}`}</span>
      </li>)}
    </ul>}
    {facts && <p className="ck-class-note">{facts}</p>}
    {product.merge_group_id !== null && <p><Link to={{ kind: 'merge', groupId: product.merge_group_id }}>Входит в группу дублей №{product.merge_group_id}</Link></p>}
  </>
}

const hidden = (text: string) => <span className="ck-class-hidden">{text}</span>
const running = (action: ActionState) => action.kind === 'pending' ? action.action : undefined

function RecordActions({ record, action, open, unavailable, optionsReload, onAction, onOpen, onClose }: Shared & { record: Classification }) {
  const name = named(record.product)
  const busy = action.kind === 'pending'
  const current = running(action)
  const mine = current && 'id' in current && current.id === record.id ? current.type : undefined
  if (!canAct(record)) return <p className={`ck-class-state ck-class-state-${record.status}`}>{statusLabel(record)}</p>
  const { can_confirm: canConfirm, can_choose: canChoose, can_reject: canReject } = record.actions
  if (!canConfirm && !canChoose && !canReject) {
    return <p className="ck-class-warning">{record.product.exists
      ? 'Обобщённый продукт товара изменён вне этого экрана. Запись закроется как „заменено“ при следующем действии или запуске.' : 'Товар удалён.'}</p>
  }
  const area = open && open.kind !== 'bulk' && open.id === record.id ? open : undefined
  if (area?.kind === 'reject') {
    return <div className="ck-class-area" role="group" tabIndex={-1} data-class-focus aria-label={`Отклонение предложения для товара «${name}»`}>
      <p>Отклонить предложение? Товар вернётся в „Не разобрано“.</p>
      <div className="ck-class-actions">
        <button type="button" disabled={busy || unavailable} onClick={() => onAction({ type: 'reject', id: record.id, input: { version: record.version } })}>
          {mine === 'reject' ? 'Отклоняем…' : 'Да, отклонить'}</button>
        <button type="button" className="ck-class-secondary" disabled={busy} onClick={() => onClose(area)}>Отмена</button>
      </div>
    </div>
  }
  if (area?.kind === 'choose') {
    return <GenericChooser record={record} busy={busy || unavailable} saving={mine === 'choose'} reload={optionsReload} onCancel={() => onClose(area)}
      onApply={(genericId) => onAction({ type: 'choose', id: record.id, input: { version: record.version, generic_id: genericId } })} />
  }
  const off = busy || unavailable
  return <div className="ck-class-actions">
    {canConfirm && <button type="button" disabled={off}
      onClick={() => onAction({ type: 'confirm', id: record.id, input: { version: record.version, generic_id: record.suggested.generic.id } })}>
      {mine === 'confirm' ? 'Подтверждаем…' : 'Подтвердить'}{hidden(`: ${name}`)}</button>}
    {canChoose && <button type="button" className="ck-class-secondary" disabled={off} data-class-trigger={areaKey({ kind: 'choose', id: record.id })}
      onClick={() => onOpen({ kind: 'choose', id: record.id })}>Выбрать другой{hidden(` обобщённый продукт для товара: ${name}`)}</button>}
    {canReject && <button type="button" className="ck-class-secondary" disabled={off} data-class-trigger={areaKey({ kind: 'reject', id: record.id })}
      onClick={() => onOpen({ kind: 'reject', id: record.id })}>Отклонить{hidden(` предложение для товара: ${name}`)}</button>}
  </div>
}

function BulkConfirm({ group, action, open, unavailable, onAction, onOpen, onClose }: Shared & { group: SuggestionGroup }) {
  const records = confirmable(group.records)
  if (records.length === 0) return null
  const busy = action.kind === 'pending'
  const current = running(action)
  const saving = current?.type === 'confirmAll' && current.genericId === group.generic.id
  const area: OpenArea = { kind: 'bulk', genericId: group.generic.id }
  const name = named(group.generic)
  if (open?.kind === 'bulk' && open.genericId === group.generic.id) {
    return <div className="ck-class-area" role="group" tabIndex={-1} data-class-focus aria-label={`Подтверждение группы «${name}»`}>
      <p>Подтвердить {productsCount(records.length)} как „{name}“?</p>
      <div className="ck-class-actions">
        <button type="button" disabled={busy || unavailable} onClick={() => onAction({ type: 'confirmAll', genericId: group.generic.id, items: confirmItems(records) })}>
          {saving ? 'Подтверждаем…' : 'Да, подтвердить'}</button>
        <button type="button" className="ck-class-secondary" disabled={busy} onClick={() => onClose(area)}>Отмена</button>
      </div>
    </div>
  }
  return <div className="ck-class-actions">
    <button type="button" disabled={busy || unavailable} data-class-trigger={areaKey(area)} onClick={() => onOpen(area)}>
      Подтвердить все ({records.length.toLocaleString('ru-RU')}){hidden(`: ${name}`)}</button>
  </div>
}

function Group({ group, product, ...shared }: Shared & { group: SuggestionGroup; product: boolean }) {
  const id = `class-group-${group.generic.id}`
  const shown = group.records.length
  return <li className="ck-class-group">
    <section aria-labelledby={id}>
      <h3 id={id}>{named(group.generic)}{group.generic.is_new && <> <span className="ck-class-new">новый</span></>}</h3>
      <p className="ck-class-path"><CategoryPath suggested={group} /></p>
      <p className="ck-class-note">Базовая единица: {unitLabels[group.generic.base_unit]} · {productsCount(shown)}</p>
      {shown < group.pendingCount && <p className="ck-class-note">
        Показано {shown.toLocaleString('ru-RU')} из {group.pendingCount.toLocaleString('ru-RU')}: {product ? 'остальные у других товаров' : 'остальные на других страницах'}
      </p>}
      <BulkConfirm group={group} {...shared} />
      <ul className="ck-class-records" aria-label={`Товары группы «${named(group.generic)}»`}>
        {group.records.map((record) => <li className="ck-class-record" key={record.id}>
          <div className="ck-class-record-main">
            <p className="ck-class-product"><ProductName record={record} /></p>
            <ProductDetails record={record} />
          </div>
          <RecordActions record={record} {...shared} />
        </li>)}
      </ul>
    </section>
  </li>
}

/** Pending records grouped by the suggested generic product, in the order of the server. */
export function GroupList({ records, product, ...shared }: Shared & { records: Classification[]; product: boolean }) {
  return <ul className="ck-class-groups">
    {groupRecords(records).map((group) => <Group key={group.generic.id} group={group} product={product} {...shared} />)}
  </ul>
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

/** Decided records, or every record under «Все»: what was suggested, what the product kept and when. No actions here. */
export function FlatList({ records }: { records: Classification[] }) {
  return <ul className="ck-class-records">
    {records.map((record) => <li className="ck-class-record ck-class-flat" key={record.id}>
      <div className="ck-class-record-main">
        <p className="ck-class-product"><ProductName record={record} /></p>
        <p className={`ck-class-state ck-class-state-${record.status}`}>{statusLabel(record)}</p>
        <ProductDetails record={record} />
      </div>
      <dl className="ck-class-facts">
        <Fact label="Предложено">{named(record.suggested.generic)} ({unitLabels[record.suggested.generic.base_unit]}) · <CategoryPath suggested={record.suggested} /></Fact>
        <Fact label="Итог">{record.final_generic ? `${named(record.final_generic)} (${unitLabels[record.final_generic.base_unit]})` : '—'}</Fact>
        <Fact label="Решено">{record.resolved_at ? <time dateTime={record.resolved_at}>{formatObservedAt(record.resolved_at)}</time> : '—'}</Fact>
      </dl>
      {canAct(record) && <p><Link to={{ kind: 'classification', query: { product: record.product.id, page: 1 } }}>
        Открыть среди ожидающих{hidden(`: ${named(record.product)}`)}</Link></p>}
    </li>)}
  </ul>
}
