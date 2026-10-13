import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ChipScroller from '../../components/ChipScroller'
import { useNarrow } from '../../lib/cards'
import { Link, maxTrendsPeriodMonths, navigate } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import {
  checkPeriod, fieldValue, supportsMonthInput, monthsCount, parsePeriodPhrase, periodHref, periodLabel, periodText, presetChoices, resolvePeriod,
} from './trends-period'
import type { Period, PeriodDraft, PeriodErrors } from './trends-period'
import { useChipInView } from './chip-in-view'
import { PeriodSheet } from './stats-period'
import { monthName } from './trends-state'


const phraseExamples = 'Например: «последние 9 месяцев», «2026», «май–октябрь 2026».'

/** «С», «По» and a period in words; `onApply` gets a checked period. Its own state starts from `period` every time it is shown. */
export function PeriodForm({ period, current, native, onApply }: { period: Period; current: string; native: boolean; onApply: (period: Period) => void }) {
  const id = useId()
  const [draft, setDraft] = useState<PeriodDraft>({ from: fieldValue(period.from, native), to: fieldValue(period.to, native) })
  const [errors, setErrors] = useState<PeriodErrors>({})
  const [phrase, setPhrase] = useState('')
  const [phraseHint, setPhraseHint] = useState(phraseExamples)
  const form = useRef<HTMLFormElement>(null)
  const set = (field: keyof PeriodDraft, value: string) => {
    setDraft((old) => ({ ...old, [field]: value }))
    setErrors((old) => ({ ...old, [field]: undefined }))
  }
  const onPhrase = (value: string) => {
    setPhrase(value)
    if (!value.trim()) { setPhraseHint(phraseExamples); return }
    const found = parsePeriodPhrase(value, current)
    if (!found) { setPhraseHint(`Не получилось разобрать. ${phraseExamples}`); return }
    setDraft({ from: fieldValue(found.from, native), to: fieldValue(found.to, native) })
    setErrors({})
    setPhraseHint(`Поняли: ${periodText(found)}.`)
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const result = checkPeriod(draft)
    if ('errors' in result) {
      setErrors(result.errors)
      const first = result.errors.from ? 'from' : 'to'
      form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus()
      return
    }
    onApply(result.period)
  }
  const field = (name: keyof PeriodDraft, text: string) => (
    <div className="stats-field">
      <label htmlFor={`${id}-${name}`}>{text}</label>
      <input id={`${id}-${name}`} name={name} type={native ? 'month' : 'text'} value={draft[name]} onChange={(event) => set(name, event.target.value)}
        {...(!native && { placeholder: 'ММ.ГГГГ', autoComplete: 'off', spellCheck: false })} min={native ? '1901-01' : undefined}
        aria-invalid={Boolean(errors[name])} aria-describedby={errors[name] ? `${id}-${name}-error` : `${id}-note`} />
      {errors[name] && <p className="stats-field-error" id={`${id}-${name}-error`}>{errors[name]}</p>}
    </div>
  )
  return (
    <form ref={form} className="trends-period-form" noValidate onSubmit={onSubmit} aria-label="Свой период">
      <div className="trends-period-fields">{field('from', 'С')}{field('to', 'По')}</div>
      <div className="stats-field trends-period-phrase">
        <label htmlFor={`${id}-phrase`}>Или словами</label>
        <input id={`${id}-phrase`} type="text" value={phrase} onChange={(event) => onPhrase(event.target.value)} placeholder="май–октябрь 2026"
          autoComplete="off" enterKeyHint="done" aria-describedby={`${id}-phrase-hint`} />
        <p className="stats-note" id={`${id}-phrase-hint`} aria-live="polite">{phraseHint}</p>
      </div>
      <p className="stats-note" id={`${id}-note`}>Оба месяца включительно, не больше {monthsCount(maxTrendsPeriodMonths)}.</p>
      <button type="submit">Показать период</button>
    </form>
  )
}

/** The current period in words: «май 2026 — октябрь 2026, 6 месяцев», months in `<time>`. */
export function PeriodText({ period }: { period: Period }) {
  const span = periodText(period)
  const count = span.slice(span.lastIndexOf(', ') + 2)
  return (
    <p className="trends-period-current" aria-live="polite">
      <span className="trends-period-label">Период: </span>
      <strong><time dateTime={period.from}>{monthName(period.from)}</time>
        {period.from !== period.to && <> — <time dateTime={period.to}>{monthName(period.to)}</time></>}</strong>, {count}
    </p>
  )
}

export interface TrendsPeriodPickerProps {
  query: TrendsQuery
  /** The month the ready periods end at: the server's once known, the person's until then. */
  current: string
  /** The first month with receipts; `undefined` while unknown, `null` without receipts. */
  first: string | null | undefined
  /** Where a period leads: «Динамика» by default (its category stays); «Доходы» of the statistics pass their own. */
  hrefOf?: (period: Period) => string
  /** For the tests: the width, the field kind and an open sheet without a browser. */
  narrow?: boolean
  native?: boolean
  open?: boolean
}

/**
 * The period of «Динамика» (and of «Доходы» in the statistics): from 541 px ready periods as chips in one sideways row,
 * the current period in words and «Свой период» inline; on a phone one button «Период: 12 месяцев ▾» that opens the
 * ready periods, the current period in words and «Свой период» in a sheet from the bottom.
 */
export default function TrendsPeriodPicker({ query, current, first, hrefOf: hrefProp, narrow: narrowProp, native: nativeProp, open }: TrendsPeriodPickerProps) {
  const measured = useNarrow()
  const narrow = narrowProp ?? measured
  const [native] = useState(() => nativeProp ?? supportsMonthInput())
  const period = resolvePeriod(query, current)
  const key = `${period.from}-${period.to}-${native}`
  const chipsRef = useChipInView<HTMLElement>(`${key}-${narrow}-${first ?? ''}`)
  const hrefOf = hrefProp ?? ((next: Period) => periodHref(query, next))
  const choices = presetChoices(query, current, first, hrefOf)
  const offTitle = first === null ? 'Чеков пока нет' : 'Узнаём, с какого месяца есть чеки…'
  const clippedTitle = `Чеки есть и раньше; показаны последние ${monthsCount(maxTrendsPeriodMonths)}`
  const form = (done?: () => void) => <PeriodForm key={key} period={period} current={current} native={native}
    onApply={(next) => { done?.(); navigate(hrefOf(next)) }} />
  if (narrow) {
    return <section className="trends-period" aria-label="Период">
      <PeriodSheet label={periodLabel(period, choices)} open={open} current={<PeriodText period={period} />}
        choices={choices.map((choice) => ({ key: choice.key, label: choice.label, href: choice.href, active: choice.active,
          title: choice.href === null ? offTitle : choice.clipped ? clippedTitle : undefined }))}>
        {form}
      </PeriodSheet>
    </section>
  }
  return (
    <section ref={chipsRef} className="trends-period" aria-label="Период">
      <ChipScroller label="Готовые периоды" className="trends-period-chips">
        {choices.map((choice) => choice.href === null
          ? <span key={choice.key} className="ck-chip trends-chip-off" aria-disabled="true" title={offTitle}>{choice.label}</span>
          : <Link key={choice.key} className="ck-chip" to={choice.href} aria-current={choice.active ? 'true' : undefined}
            title={choice.clipped ? clippedTitle : undefined}>{choice.label}</Link>)}
      </ChipScroller>
      <PeriodText period={period} />
      <div className="trends-period-custom">
        <h3 className="trends-subheading">Свой период</h3>
        {form()}
      </div>
    </section>
  )
}
