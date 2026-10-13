import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Contribution, Goal } from '../../api/goals'
import { currencySymbol } from '../../lib/money'
import type { Person } from '../../lib/people'
import { contributionDraftOf, goalDraftOf, goalErrors, moneyValue } from './goals-state'
import type { ContributionDraft, GoalDraft, GoalErrors } from './goals-state'

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

/** A new goal or a change of one: the name, the amount and its currency, an optional deadline, whose it is. */
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
