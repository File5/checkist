import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Contribution, Goal } from '../../api/goals'
import { currencySymbol } from '../../lib/money'
import type { Person } from '../../lib/people'
import { contributionDraftOf, contributionTitle, dayText, goalDraftOf, goalErrors, moneyValue } from './goals-state'
import type { ContributionDraft, GoalDraft, GoalErrors, ReconcileDraft } from './goals-state'

/** A field as a row of the sheet: the words on the left, the control on the right; its error under the row. */
function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return <div className="goal-field-wrap">
    <label className="goal-field" htmlFor={id}><span>{label}</span>{children}</label>
    {error && <p className="goal-field-error" id={`${id}-error`}>{error}</p>}
  </div>
}

/** A deletion asks once more, in place of its button. */
function Remove({ question, label, busy, onDelete }: { question: string; label: string; busy: boolean; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return confirming
    ? <div className="goal-confirm">
      <p>{question}</p>
      <button type="button" className="ck-button-danger" aria-disabled={busy || undefined} onClick={busy ? undefined : onDelete}>Удалить</button>
      <button type="button" className="ck-button-secondary" onClick={() => setConfirming(false)}>Отмена</button>
    </div>
    : <button type="button" className="ck-button-danger" onClick={() => setConfirming(true)}>{label}</button>
}

export type GoalFormProps = {
  goal: Goal | null
  currency: string
  /** The person has a family: the goal may be shared. */
  household: boolean
  busy: boolean
  failure?: string | null
  onSubmit: (draft: GoalDraft) => void
  onDelete?: () => void
}

/** Two or three pressed chips of one choice. */
function Chips<T extends string>({ legend, value, options, onChange, note }: {
  legend: string; value: T; options: [T, string][]; onChange: (value: T) => void; note?: string
}) {
  return <fieldset className="goal-kind-choice">
    <legend>{legend}</legend>
    <div className="goal-chips">
      {options.map(([key, label]) => <button key={key} type="button" className="ck-chip" aria-pressed={value === key} onClick={() => onChange(key)}>{label}</button>)}
    </div>
    {note && <p className="goal-note">{note}</p>}
  </fieldset>
}

/** A new goal or a change of one: the name, the amount and its currency, an optional deadline, whose it is; a deposit —
 * its rate and capitalization. */
export function GoalForm({ goal, currency, household, busy, failure = null, onSubmit, onDelete }: GoalFormProps) {
  const [draft, setDraft] = useState<GoalDraft>(() => goalDraftOf(goal, currency, household))
  const [errors, setErrors] = useState<GoalErrors>({})
  const set = (patch: Partial<GoalDraft>) => setDraft((before) => ({ ...before, ...patch }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = goalErrors(draft)
    setErrors(found)
    if (!Object.keys(found).length) onSubmit(draft)
  }
  const described = (name: keyof GoalErrors) => (errors[name] ? `goal-form-${name}-error` : undefined)
  return <form className="goal-form" onSubmit={submit} noValidate>
    <div className="goal-fields">
      <Field id="goal-form-name" label="Название" error={errors.name}>
        <input id="goal-form-name" value={draft.name} maxLength={100} placeholder="Отпуск" autoComplete="off"
          aria-invalid={Boolean(errors.name)} aria-describedby={described('name')} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field id="goal-form-amount" label="Сколько нужно" error={errors.amount}>
        <input id="goal-form-amount" className="ck-figures" value={draft.amount} inputMode="decimal" autoComplete="off" placeholder="0"
          aria-invalid={Boolean(errors.amount)} aria-describedby={described('amount')} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="goal-form-currency" label="Валюта" error={errors.currency}>
        <input id="goal-form-currency" value={draft.currency} maxLength={3} autoCapitalize="characters" autoComplete="off" spellCheck={false}
          aria-invalid={Boolean(errors.currency)} aria-describedby={described('currency')}
          onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
      </Field>
      <Field id="goal-form-deadline" label="Срок">
        <input id="goal-form-deadline" type="date" value={draft.deadline} onChange={(event) => set({ deadline: event.target.value })} />
      </Field>
    </div>
    <Chips legend="Где копите" value={draft.kind} options={[['saving', 'Копилка'], ['deposit', 'Депозит']]} onChange={(kind) => set({ kind })}
      note={draft.kind === 'deposit' ? 'Посчитаю проценты по ставке и подскажу, по сколько вносить.' : undefined} />
    {draft.kind === 'deposit' && <>
      <div className="goal-fields">
        <Field id="goal-form-rate" label="Ставка, % годовых" error={errors.rate}>
          <input id="goal-form-rate" className="ck-figures" value={draft.rate} inputMode="decimal" autoComplete="off" placeholder="14,5"
            aria-invalid={Boolean(errors.rate)} aria-describedby={described('rate')} onChange={(event) => set({ rate: event.target.value })} />
        </Field>
      </div>
      <Chips legend="Капитализация" value={draft.capitalization} options={[['monthly', 'Ежемесячно'], ['none', 'Без капитализации']]}
        onChange={(capitalization) => set({ capitalization })}
        note={draft.capitalization === 'monthly' ? 'Проценты прибавляются к сумме 1-го числа — как у Kaspi Депозита.' : 'Проценты копятся отдельно и сами процентов не приносят.'} />
    </>}
    {household && <fieldset className="goal-kind-choice">
      <legend>Чья цель</legend>
      <div className="goal-chips">
        <button type="button" className="ck-chip" aria-pressed={draft.shared} onClick={() => set({ shared: true })}>Общая семьи</button>
        <button type="button" className="ck-chip" aria-pressed={!draft.shared} onClick={() => set({ shared: false })}>Личная</button>
      </div>
      <p className="goal-note">{draft.shared ? 'Видят и меняют все в семье.' : 'Видите вы и главный в семье.'}</p>
    </fieldset>}
    {failure && <p className="goal-field-error" role="alert">{failure}</p>}
    <button type="submit" className="goal-submit" aria-disabled={busy || undefined}>{goal ? 'Сохранить' : 'Добавить цель'}</button>
    {goal && onDelete && <Remove question={`Удалить «${goal.name}» вместе со взносами?`} label="Удалить цель" busy={busy} onDelete={onDelete} />}
  </form>
}

export type ReconcileFormProps = {
  currency: string
  /** «≈ 567 153 ₸» on the deposit today by the count, formatted. */
  saved: string
  today: string
  busy: boolean
  failure?: string | null
  onSubmit: (draft: ReconcileDraft) => void
}

/** «Сверить с банком»: the balance the bank shows on a day; the difference with the count becomes a record «проценты». */
export function ReconcileForm({ currency, saved, today, busy, failure = null, onSubmit }: ReconcileFormProps) {
  const [draft, setDraft] = useState<ReconcileDraft>({ balance: '', date: today })
  const [error, setError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const wrong = moneyValue(draft.balance) === null
    setError(wrong ? 'Остаток больше нуля.' : null)
    if (!wrong && draft.date) onSubmit(draft)
  }
  return <form className="goal-form" onSubmit={submit} noValidate>
    <p className="goal-note">По расчёту сегодня на депозите <span className="ck-figures">{saved}</span>. Впишите остаток из приложения банка —
      разница запишется в историю как проценты, и дальше расчёт пойдёт от него.</p>
    <div className="goal-fields">
      <Field id="goal-bank-balance" label={`Остаток в банке, ${currencySymbol(currency)}`} error={error ?? undefined}>
        <input id="goal-bank-balance" className="ck-figures" value={draft.balance} inputMode="decimal" autoComplete="off" placeholder="0"
          aria-invalid={Boolean(error)} aria-describedby={error ? 'goal-bank-balance-error' : undefined}
          onChange={(event) => setDraft({ ...draft, balance: event.target.value })} />
      </Field>
      <Field id="goal-bank-date" label="На дату">
        <input id="goal-bank-date" type="date" value={draft.date} max={today} required onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
      </Field>
    </div>
    {failure && <p className="goal-field-error" role="alert">{failure}</p>}
    <button type="submit" className="goal-submit" aria-disabled={busy || undefined}>Сверить</button>
  </form>
}

/** A record «проценты» is not edited, only removed: the next reconciliation counts from the rest. */
export function InterestRecord({ item, busy, failure = null, onDelete }: { item: Contribution; busy: boolean; failure?: string | null; onDelete: () => void }) {
  return <div className="goal-form">
    <p className="goal-note">{contributionTitle(item)} на {dayText(item.date)}. Это не взнос, а разница сверки депозита с банком: в «откладываете»
      она не входит.</p>
    {failure && <p className="goal-field-error" role="alert">{failure}</p>}
    <Remove question="Удалить эту сверку?" label="Удалить сверку" busy={busy} onDelete={onDelete} />
  </div>
}

export type ContributionFormProps = {
  item: Contribution | null
  /** The currency of a new contribution — the goal's; a contribution keeps its own. */
  currency: string
  people: Person[]
  today: string
  /** The person filling the form: the default «кто». */
  user: string
  busy: boolean
  failure?: string | null
  onSubmit: (draft: ContributionDraft) => void
  onDelete?: () => void
}

/** A contribution: how much, on which day and who put it aside. */
export function ContributionForm({ item, currency, people, today, user, busy, failure = null, onSubmit, onDelete }: ContributionFormProps) {
  const [draft, setDraft] = useState<ContributionDraft>(() => contributionDraftOf(item, today, user))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<ContributionDraft>) => setDraft((before) => ({ ...before, ...patch }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const wrong = moneyValue(draft.amount) === null
    setError(wrong ? 'Сумма больше нуля.' : null)
    if (!wrong && draft.date) onSubmit(draft)
  }
  return <form className="goal-form" onSubmit={submit} noValidate>
    <div className="goal-fields">
      <Field id="goal-gift-amount" label={`Сумма, ${currencySymbol(item?.currency ?? currency)}`} error={error ?? undefined}>
        <input id="goal-gift-amount" className="ck-figures" value={draft.amount} inputMode="decimal" autoComplete="off" placeholder="0"
          aria-invalid={Boolean(error)} aria-describedby={error ? 'goal-gift-amount-error' : undefined}
          onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="goal-gift-date" label="Дата">
        <input id="goal-gift-date" type="date" value={draft.date} required onChange={(event) => set({ date: event.target.value })} />
      </Field>
      {people.length > 1 && <Field id="goal-gift-user" label="Кто отложил">
        <select id="goal-gift-user" value={draft.user} onChange={(event) => set({ user: event.target.value })}>
          {people.map((person) => <option key={person.username} value={person.username}>{person.display_name}</option>)}
        </select>
      </Field>}
    </div>
    {failure && <p className="goal-field-error" role="alert">{failure}</p>}
    <button type="submit" className="goal-submit" aria-disabled={busy || undefined}>{item ? 'Сохранить' : 'Добавить взнос'}</button>
    {item && onDelete && <Remove question="Удалить этот взнос?" label="Удалить взнос" busy={busy} onDelete={onDelete} />}
  </form>
}
