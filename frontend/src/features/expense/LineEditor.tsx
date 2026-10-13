import { useEffect, useRef, useState } from 'react'
import type { Category } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { categoryTree, LINES_MAX, sentIndexes } from './expense-form'
import type { ExpenseErrors } from './expense-form'
import { editLine, lineSummary, newLine, serviceLine, settleLine, UNIT_LABELS, UNITS, withService } from './line-draft'
import type { LineDraft, LineField } from './line-draft'

export type LineEditorProps = {
  lines: LineDraft[]; errors: ExpenseErrors; chips: Category[]; currency: string
  onChange: (lines: LineDraft[]) => void
  /** A phone: a line is a folded card «Панини · 2 шт × 1 790,00 ₸ · 3 580 ₸», a tap unfolds its fields. */
  narrow?: boolean
  /** What a line without its own category falls back to: the category of the spend, or of the product (a photo receipt). */
  defaultCategory: string
  /** Discounts of the whole receipt, as the API decimal: shown under the lines, already taken from the total. */
  extraDiscount?: string
  /** The spend typed without positions as its first position, for «＋ Обслуживание %»; `undefined` — no sum typed. */
  asLine?: () => LineDraft | undefined
}

/** «Кафе и рестораны» › «Обслуживание и чаевые» of the catalog (the migration `catalog.0003`), if it is there. */
function serviceCategory(chips: Category[]): number | null {
  return chips.find((category) => category.name === 'Обслуживание и чаевые' && category.path[0]?.name === 'Кафе и рестораны')?.id ?? null
}

const errorId = (name: string) => `expense-${name.replaceAll('.', '-')}-error`

function Chevron() {
  return <svg className="expense-line-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
}

/**
 * «Позиции» of the spend form: every line as on a receipt — name, quantity, unit, price, discount, sum and category
 * (one form for every spend, 2026-10-13). A wide screen shows the fields of every line; a phone folds each line into a
 * card and unfolds the tapped one, a new one and any with a message.
 */
export default function LineEditor({ lines, errors, chips, currency, onChange: change, narrow = false, defaultCategory, extraDiscount, asLine }: LineEditorProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const added = useRef<number | undefined>(undefined)
  // Errors name a position by its place among the sent ones: an untouched empty row is not sent.
  const sent = sentIndexes(lines)
  const tree = categoryTree(chips)
  // Every change goes through `withService`: «Обслуживание N%» follows the other positions.
  const onChange = (next: LineDraft[]) => change(withService(next))
  const update = (key: number, change: (line: LineDraft) => LineDraft) => onChange(lines.map((line) => line.key === key ? change(line) : line))
  // A typed sum makes «Обслуживание» an ordinary position: the person knows better than the percent.
  const type = (key: number, field: LineField, text: string) =>
    update(key, (line) => ({ ...editLine(line, field, text), ...(field === 'amount' && { service: undefined }) }))
  const add = (line = newLine(), before: LineDraft[] = []) => {
    added.current = line.key
    setOpen((keys) => new Set(keys).add(line.key))
    onChange([...lines, ...before, line])
  }
  // Without positions the typed sum of the spend becomes the first one: the service is counted on top of it.
  const addService = () => add(serviceLine(serviceCategory(chips)), lines.length ? [] : [asLine?.()].filter((line): line is LineDraft => line !== undefined))
  const hasService = lines.some((line) => line.service !== undefined)
  const toggle = (key: number) => setOpen((keys) => {
    const next = new Set(keys)
    if (!next.delete(key)) next.add(key)
    return next
  })
  // A new position is typed right away.
  useEffect(() => {
    if (added.current === undefined) return
    document.getElementById(`expense-line-${added.current}-name`)?.focus()
    added.current = undefined
  }, [lines])

  return <div className="expense-row-block expense-lines" role="group" aria-labelledby="expense-lines-heading">
    <div className="expense-row">
      <span id="expense-lines-heading" className="expense-row-label">Позиции</span>
      {lines.length < LINES_MAX && <button type="button" className="expense-add-line" onClick={() => add()}>
        <span aria-hidden="true">+</span> Добавить<span className="expense-visually-hidden"> позицию</span></button>}
    </div>
    {lines.length > 0 && <ol className="expense-line-list">{lines.map((line, index) => {
      const at = sent[index]
      const name = (field: LineField) => `lines.${at}.${field}`
      const failed = (['name', 'quantity', 'price', 'discount', 'amount'] as const).filter((field) => errors[name(field)])
      const unfolded = !narrow || open.has(line.key) || failed.length > 0
      const summary = lineSummary(line, currency)
      const id = (field: string) => `expense-line-${line.key}-${field}`
      const described = (field: LineField) => errors[name(field)] ? errorId(name(field)) : undefined
      const number = (field: 'quantity' | 'price' | 'discount' | 'amount', label: string, placeholder = '') =>
        <label className={`expense-line-field expense-line-${field}-field`} htmlFor={id(field)}>
          <span className="expense-line-label">{label}</span>
          <input id={id(field)} className={`expense-line-input expense-line-${field}`} inputMode="decimal" autoComplete="off"
            placeholder={placeholder} value={line[field]} aria-invalid={Boolean(errors[name(field)])} aria-describedby={described(field)}
            onChange={(event) => type(line.key, field, event.target.value)}
            onBlur={field === 'amount' ? () => update(line.key, settleLine) : undefined} />
        </label>
      return <li key={line.key} className={`expense-line${unfolded ? ' expense-line-open' : ''}${narrow ? ' expense-line-card' : ''}`}>
        {narrow && <button type="button" className="expense-line-summary" aria-expanded={unfolded} aria-controls={id('fields')}
          onClick={() => toggle(line.key)}>
          <span className="expense-line-text">
            <span className="expense-line-title">{summary.title}</span>
            {summary.detail && <span className="expense-line-detail">{summary.detail}</span>}
          </span>
          <span className="expense-line-sum">{summary.sum}</span>
          <Chevron />
        </button>}
        {unfolded && <div id={id('fields')} className="expense-line-fields">
          <label className="expense-line-field expense-line-name-field" htmlFor={id('name')}>
            <span className="expense-line-label">Позиция {index + 1}</span>
            <input id={id('name')} className="expense-line-input expense-line-name" autoComplete="off" placeholder="Название" value={line.name}
              aria-invalid={Boolean(errors[name('name')])} aria-describedby={described('name')}
              onChange={(event) => type(line.key, 'name', event.target.value)} />
          </label>
          {line.service !== undefined
            ? <label className="expense-line-field expense-line-percent-field" htmlFor={id('percent')}>
              <span className="expense-line-label">Процент</span>
              <input id={id('percent')} className="expense-line-input expense-line-percent" inputMode="decimal" autoComplete="off"
                placeholder="10" value={line.service} onChange={(event) => update(line.key, (current) => ({ ...current, service: event.target.value }))} />
            </label>
            : <>
              {number('quantity', 'Кол-во', '1')}
              <label className="expense-line-field expense-line-unit-field" htmlFor={id('unit')}>
                <span className="expense-line-label">Ед.</span>
                <select id={id('unit')} className="expense-line-input expense-line-unit" value={line.unit}
                  onChange={(event) => update(line.key, (current) => ({ ...current, unit: event.target.value as LineDraft['unit'] }))}>
                  {UNITS.map((unit) => <option key={unit} value={unit}>{UNIT_LABELS[unit]}</option>)}
                </select>
              </label>
              {number('price', 'Цена', '0')}
              {number('discount', 'Скидка', '0')}
            </>}
          {number('amount', 'Сумма', '0')}
          <label className="expense-line-field expense-line-category-field" htmlFor={id('category')}>
            <span className="expense-line-label">Категория</span>
            <select id={id('category')} className="expense-line-input expense-line-category" value={line.category ?? ''}
              onChange={(event) => update(line.key, (current) => ({ ...current, category: event.target.value ? Number(event.target.value) : null }))}>
              <option value="">{defaultCategory}</option>
              {tree.map(({ category, depth }) => <option key={category.id} value={category.id}>
                {`${'\u2003'.repeat(depth)}${category.name}`}</option>)}
            </select>
          </label>
          <button type="button" className="expense-line-remove" aria-label={`Убрать позицию ${index + 1}`}
            onClick={() => onChange(lines.filter((other) => other.key !== line.key))}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
            {narrow && <span>Убрать</span>}
          </button>
        </div>}
        {failed.map((field) => <p key={field} className="expense-error" id={errorId(name(field))}>{errors[name(field)]}</p>)}
      </li>
    })}</ol>}
    {!hasService && lines.length < LINES_MAX - 1 && <button type="button" className="expense-add-line expense-add-service" onClick={addService}>
      <span aria-hidden="true">+</span> Обслуживание %</button>}
    {extraDiscount && <p className="expense-hint-note expense-extra-discount">
      Скидка на весь чек: −{formatMoney(extraDiscount, currency)}, уже вычтена из итога.</p>}
    {errors.lines && <p className="expense-error" id={errorId('lines')}>{errors.lines}</p>}
  </div>
}
