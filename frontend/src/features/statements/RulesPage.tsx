import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { getCategories } from '../../api/catalog'
import { getGoals } from '../../api/goals'
import type { Goal } from '../../api/goals'
import { createStatementRule, deleteStatementRule, getStatementRules, updateStatementRule } from '../../api/statements'
import type { StatementRule, StatementRuleAction, StatementRuleInput } from '../../api/statements'
import type { Category } from '../../api/types'
import RequestState from '../../components/RequestState'
import Icon from '../../components/Icon'
import { actionLabels, categoryOptions, ruleMeta } from './statement-state'
import { statementFailure, statementTexts } from './statement-texts'
import './Statements.css'

type Draft = { pattern: string; action: StatementRuleAction; category: number | null; store: string; goal: number | null }
const emptyDraft: Draft = { pattern: '', action: 'category', category: null, store: '', goal: null }
const draftOf = (rule: StatementRule): Draft => ({
  pattern: rule.pattern, action: rule.action, category: rule.category?.id ?? null, store: rule.store_name ?? '', goal: rule.goal?.id ?? null,
})
const bodyOf = (draft: Draft): StatementRuleInput => draft.action === 'category'
  ? { pattern: draft.pattern.trim(), action: 'category', category: draft.category, store_name: draft.store.trim() }
  : draft.action === 'goal'
    ? { pattern: draft.pattern.trim(), action: 'goal', category: null, goal: draft.goal }
    : { pattern: draft.pattern.trim(), action: draft.action, category: null }

type EditorProps = { id: string; initial: Draft; options: { id: number; label: string }[]; goals: Goal[]; busy: boolean; submit: string
  onSubmit: (draft: Draft) => void; onDelete?: () => void; onCancel: () => void }

/** The fields of a rule: the payee as the bank writes it, what to do, and for a category its name and the place. */
function RuleEditor({ id, initial, options, goals, busy, submit, onSubmit, onDelete, onCancel }: EditorProps) {
  const [draft, setDraft] = useState(initial)
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const ready = draft.pattern.trim() !== '' && (draft.action !== 'category' || draft.category !== null)
    && (draft.action !== 'goal' || draft.goal !== null)
  const send = (event: FormEvent) => { event.preventDefault(); if (ready && !busy) onSubmit(draft) }
  return <form className="statement-rule-form" onSubmit={send} noValidate>
    <label className="statement-field">
      <span>Получатель</span>
      <input id={`${id}-pattern`} type="text" value={draft.pattern} maxLength={200} autoComplete="off" placeholder="Как в выписке: «Олег Б.»"
        onChange={(event) => set({ pattern: event.target.value })} />
    </label>
    <fieldset className="statement-actions-choice">
      <legend>Что делать</legend>
      <div className="statement-chips">
        {(Object.keys(actionLabels) as StatementRuleAction[]).map((action) => <button key={action} type="button" className="ck-chip"
          aria-pressed={draft.action === action} onClick={() => set({ action })}>{actionLabels[action]}</button>)}
      </div>
    </fieldset>
    {draft.action === 'category' && <>
      <label className="statement-field">
        <span>Категория</span>
        <select value={draft.category ?? ''} onChange={(event) => set({ category: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Выберите категорию</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label className="statement-field">
        <span>Где</span>
        <input type="text" value={draft.store} maxLength={100} autoComplete="off" placeholder="Как в выписке"
          onChange={(event) => set({ store: event.target.value })} />
      </label>
    </>}
    {draft.action === 'goal' && <>
      <label className="statement-field">
        <span>Цель</span>
        <select value={draft.goal ?? ''} onChange={(event) => set({ goal: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Выберите цель</option>
          {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
        </select>
      </label>
      <p className="statement-note statement-small">Переводы этому получателю станут взносами в цель, а не тратами. Правило личное: только
        для ваших выписок.</p>
    </>}
    <div className="statement-rule-buttons">
      <button type="submit" disabled={!ready || busy}>{submit}</button>
      <button type="button" className="ck-button-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
      {onDelete && <button type="button" className="ck-button-danger" disabled={busy} onClick={onDelete}>Удалить</button>}
    </div>
  </form>
}

export type RulesViewProps = {
  rules: StatementRule[]
  categories: Category[]
  goals?: Goal[]
  open: number | 'new' | null
  busy: boolean
  message: string | null
  search: string
  onSearch: (text: string) => void
  onOpen: (id: number | 'new' | null) => void
  onCreate: (input: StatementRuleInput) => void
  onUpdate: (id: number, input: StatementRuleInput) => void
  onDelete: (id: number) => void
}

/** The rules without the network: the markup tests render it directly. */
export function RulesView({ rules, categories, goals = [], open, busy, message, search, onSearch, onOpen, onCreate, onUpdate, onDelete }: RulesViewProps) {
  const options = useMemo(() => categoryOptions(categories), [categories])
  const byId = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const words = search.trim().toLocaleLowerCase('ru')
  const shown = words ? rules.filter((rule) => rule.pattern.toLocaleLowerCase('ru').includes(words)) : rules
  return <div className="statements ck-stack">
    <p className="statement-note">{statementTexts.rulesIntro}</p>
    {message && <p className="statement-notice" role="status">{message}</p>}
    <section className="ck-panel" aria-labelledby="statement-rule-new-heading">
      <div className="ck-panel-head">
        <h2 id="statement-rule-new-heading">Новое правило</h2>
        {open !== 'new' && <button type="button" className="ck-button-secondary statement-add" onClick={() => onOpen('new')}>
          <Icon name="plus" size={18} />Добавить</button>}
      </div>
      {open === 'new' && <RuleEditor id="statement-rule-new" initial={emptyDraft} options={options} goals={goals} busy={busy} submit="Добавить правило"
        onSubmit={(draft) => onCreate(bodyOf(draft))} onCancel={() => onOpen(null)} />}
    </section>
    <section className="ck-panel" aria-labelledby="statement-rules-heading">
      <div className="ck-panel-head"><h2 id="statement-rules-heading">Правила</h2><span className="statement-count">{rules.length}</span></div>
      {rules.length > 8 && <label className="statement-field statement-search">
        <span>Найти</span>
        <input type="search" value={search} placeholder="Получатель" autoComplete="off" onChange={(event) => onSearch(event.target.value)} />
      </label>}
      {rules.length === 0
        ? <p className="statement-note">{statementTexts.noRules}</p>
        : <ul className="ck-list statement-rules">
          {shown.map((rule) => <li key={rule.id}>
            <button type="button" className="statement-rule-open" aria-expanded={open === rule.id} onClick={() => onOpen(open === rule.id ? null : rule.id)}>
              <span className="ck-row-main">
                <span className="ck-row-title">{rule.pattern}</span>
                <span className="ck-row-meta">{ruleMeta(rule, byId)}</span>
              </span>
              {rule.origin === 'learned' && <span className="statement-learned">выучено</span>}
            </button>
            {open === rule.id && <RuleEditor id={`statement-rule-${rule.id}`} initial={draftOf(rule)} options={options} goals={goals} busy={busy}
              submit="Сохранить" onSubmit={(draft) => onUpdate(rule.id, bodyOf(draft))} onDelete={() => onDelete(rule.id)}
              onCancel={() => onOpen(null)} />}
          </li>)}
        </ul>}
    </section>
  </div>
}

/** «Правила выписок»: the family's payee rules — view, add, change, delete. */
export default function RulesPage() {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; rules: StatementRule[] }>({ kind: 'loading' })
  const [categories, setCategories] = useState<Category[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [open, setOpen] = useState<number | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    void getStatementRules({ signal: abort.signal }).then((result) => {
      if (result.kind === 'ok') setState({ kind: 'ok', rules: result.data.results })
      else if (result.kind === 'error') setState({ kind: 'error', message: statementFailure(result) })
    })
    void getCategories({}, { signal: abort.signal }).then((result) => { if (result.kind === 'ok') setCategories(result.data.results) })
    void getGoals({ signal: abort.signal }).then((result) => { if (result.kind === 'ok') setGoals(result.data.results) })
    return () => abort.abort()
  }, [attempt])
  if (state.kind === 'loading') return <RequestState kind="loading" message="Загружаем правила…" />
  if (state.kind === 'error') return <RequestState kind="error" message={state.message} onRetry={() => { setState({ kind: 'loading' }); setAttempt((value) => value + 1) }} />
  const rules = state.rules
  const sorted = (list: StatementRule[]) => [...list].sort((a, b) => a.pattern.localeCompare(b.pattern, 'ru'))
  const run = async <T,>(action: () => Promise<{ kind: 'ok'; data: T } | { kind: 'error' } & Parameters<typeof statementFailure>[0] | { kind: 'aborted' }>,
    done: (data: T) => void) => {
    setBusy(true)
    setMessage(null)
    const result = await action()
    setBusy(false)
    if (result.kind === 'ok') done(result.data)
    else if (result.kind === 'error') setMessage(result.reason === 'invalid_parameter' && result.fields?.includes('pattern')
      ? 'Правило для этого получателя уже есть или получатель пуст.' : statementFailure(result))
  }
  return <RulesView rules={rules} categories={categories} goals={goals} open={open} busy={busy} message={message} search={search} onSearch={setSearch} onOpen={setOpen}
    onCreate={(input) => { void run(() => createStatementRule(input), (rule: StatementRule) => {
      setState({ kind: 'ok', rules: sorted([...rules, rule]) }); setOpen(null); setMessage('Правило добавлено.') }) }}
    onUpdate={(id, input) => { void run(() => updateStatementRule(id, input), (rule: StatementRule) => {
      setState({ kind: 'ok', rules: sorted(rules.map((item) => item.id === id ? rule : item)) }); setOpen(null); setMessage('Правило сохранено.') }) }}
    onDelete={(id) => { void run(() => deleteStatementRule(id), () => {
      setState({ kind: 'ok', rules: rules.filter((item) => item.id !== id) }); setOpen(null); setMessage('Правило удалено.') }) }} />
}
