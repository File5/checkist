import { useEffect, useState } from 'react'
import { createGoal, getGoals } from '../../api/goals'
import type { Goal, GoalList } from '../../api/goals'
import Icon from '../../components/Icon'
import RequestState from '../../components/RequestState'
import Sheet from '../../components/Sheet'
import { Link, navigate } from '../../navigation'
import { GoalForm } from './GoalForms'
import { barShare, goalBody, goalFailure, goalMeta, savedOf } from './goals-state'
import type { GoalDraft } from './goals-state'
import './Goals.css'

/** A goal of the list: the name, saved of the amount, the bar, whose and till when; the whole row opens it. */
export function GoalRow({ goal }: { goal: Goal }) {
  return <li>
    <Link className="ck-row goal-row" to={`/goals/${goal.id}`}>
      <span className={`ck-row-badge goal-badge${goal.reached ? ' goal-badge-done' : ''}`} aria-hidden="true"><Icon name="goal" size={20} /></span>
      <span className="ck-row-main">
        <span className="ck-row-title">{goal.name}</span>
        <span className="ck-row-meta ck-figures goal-row-sum">{savedOf(goal)}</span>
        <span className="ck-bar goal-bar" aria-hidden="true"><span style={{ width: `${barShare(goal)}%` }} /></span>
        <span className="ck-row-meta">{goalMeta(goal)}</span>
      </span>
      <span className="ck-row-amount ck-figures">{goal.percent}&nbsp;%</span>
    </Link>
  </li>
}

function Group({ id, title, goals }: { id: string; title: string; goals: Goal[] }) {
  if (!goals.length) return null
  return <section className="ck-panel" aria-labelledby={id}>
    <div className="ck-panel-head"><h2 id={id}>{title}</h2></div>
    <ul className="ck-list goal-list">{goals.map((goal) => <GoalRow key={goal.id} goal={goal} />)}</ul>
  </section>
}

/** `/goals` without loading: the markup tests render it directly. */
export function GoalsView({ data, onAdd }: { data: GoalList; onAdd: () => void }) {
  const shared = data.results.filter((goal) => goal.shared)
  const personal = data.results.filter((goal) => !goal.shared)
  return <div className="goals ck-stack">
    {data.results.length === 0
      ? <section className="ck-panel goal-empty">
        <h2>Целей пока нет</h2>
        <p className="goal-note">Отпуск, подушка, подарок — задайте сумму и срок, отмечайте взносы, а я покажу, сколько уже накоплено
          и когда цель будет достигнута. Переводы на свой депозит из выписки тоже станут взносами.</p>
      </section>
      : <>
        <Group id="goals-shared-heading" title={data.household ? 'Общие семьи' : 'Цели'} goals={shared} />
        <Group id="goals-personal-heading" title={shared.length || data.household ? 'Личные' : 'Цели'} goals={personal} />
      </>}
    <button type="button" className="goal-add" aria-haspopup="dialog" onClick={onAdd}><Icon name="plus" size={20} />Новая цель</button>
  </div>
}

/** «Цели»: shared goals of the family, then personal ones; a new goal in a sheet opens its page. */
export default function GoalsPage() {
  const [load, setLoad] = useState<{ kind: 'error'; message: string } | { kind: 'ok'; data: GoalList }>()
  const [attempt, setAttempt] = useState(0)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void getGoals({ signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setLoad({ kind: 'ok', data: result.data })
      else if (result.kind === 'error') setLoad({ kind: 'error', message: goalFailure(result) })
    })
    return () => controller.abort()
  }, [attempt])
  if (!load) return <RequestState kind="loading" message="Загружаем цели…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  const { data } = load
  const save = (draft: GoalDraft) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    void createGoal(goalBody(draft, data.household)).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') navigate(`/goals/${result.data.id}`)
      else if (result.kind === 'error') setFailure(goalFailure(result))
    })
  }
  return <>
    <GoalsView data={data} onAdd={() => { setFailure(null); setAdding(true) }} />
    <Sheet open={adding} onClose={() => setAdding(false)} title="Новая цель">
      {adding && <GoalForm goal={null} currency={data.base_currency} household={data.household} busy={busy} failure={failure} onSubmit={save} />}
    </Sheet>
  </>
}
