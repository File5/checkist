import { useEffect, useState } from 'react'
import { addContribution, deleteContribution, deleteGoal, getGoal, updateContribution, updateGoal } from '../../api/goals'
import type { Contribution, GoalDetail } from '../../api/goals'
import type { LocalApiResult } from '../../api/types'
import RequestState from '../../components/RequestState'
import Sheet from '../../components/Sheet'
import { usePageTitle } from '../../components/page-header'
import { formatMoney } from '../../lib/money'
import { initials } from '../../lib/people'
import { navigate } from '../../navigation'
import { useSession } from '../../session'
import { ContributionForm, GoalForm } from './GoalForms'
import {
  barShare, contributionBody, contributionMeta, deadlineText, excludedText, goalBody, goalFailure, kindText, paceText,
} from './goals-state'
import type { ContributionDraft, GoalDraft } from './goals-state'
import './Goals.css'

export type GoalViewProps = {
  goal: GoalDetail
  notice?: string | null
  onAdd?: () => void
  onEditGoal?: () => void
  onEdit?: (item: Contribution) => void
}

/** One goal without loading: the progress card, the forecast, the history of contributions. */
export function GoalView({ goal, notice = null, onAdd = () => {}, onEditGoal = () => {}, onEdit = () => {} }: GoalViewProps) {
  const pace = paceText(goal)
  const deadline = deadlineText(goal)
  const excluded = excludedText(goal)
  return <div className="goals ck-stack">
    <section className="ck-panel goal-hero" aria-label="Прогресс">
      <p className="goal-kind">{kindText(goal)}</p>
      <p className="goal-hero-sum"><span className="ck-hero-figure">{formatMoney(goal.saved, goal.currency)}</span></p>
      <p className="goal-of">из <span className="ck-figures">{formatMoney(goal.amount, goal.currency)}</span> · <span className="ck-figures">{goal.percent}&nbsp;%</span></p>
      <div className={`ck-bar goal-bar-big${goal.reached ? ' goal-bar-done' : ''}`} role="img" aria-label={`Накоплено ${goal.percent} %`}>
        <span style={{ width: `${barShare(goal)}%` }} />
      </div>
      {goal.reached && <p className="goal-reached">Цель достигнута.</p>}
      {pace && <p className="goal-line">{pace}</p>}
      {deadline && <p className={`goal-line${goal.overdue ? ' goal-overdue' : ''}`}>{deadline}</p>}
      {excluded && <p className="goal-note">{excluded}</p>}
      <div className="goal-actions">
        <button type="button" aria-haspopup="dialog" onClick={onAdd}>Добавить взнос</button>
        <button type="button" className="ck-button-secondary" aria-haspopup="dialog" onClick={onEditGoal}>Изменить цель</button>
      </div>
    </section>
    {notice && <p className="goal-notice" role="status">{notice}</p>}
    <section className="ck-panel" aria-labelledby="goal-history-heading">
      <div className="ck-panel-head"><h2 id="goal-history-heading">Взносы</h2><span className="goal-count">{goal.contributions.length}</span></div>
      {goal.contributions.length
        ? <ul className="ck-list goal-list">{goal.contributions.map((item) => <li key={item.id}>
          <button type="button" className="ck-row goal-gift" aria-haspopup="dialog" onClick={() => onEdit(item)}>
            <span className="ck-row-badge goal-person" aria-hidden="true">{initials(item.user?.display_name ?? '?')}</span>
            <span className="ck-row-main">
              <span className="ck-row-title ck-figures">+{formatMoney(item.amount, item.currency)}</span>
              <span className="ck-row-meta">{contributionMeta(item)}</span>
            </span>
          </button>
        </li>)}</ul>
        : <p className="goal-note">Взносов пока нет. Добавьте первый — или отметьте перевод на депозит в черновике выписки
          как взнос в эту цель.</p>}
    </section>
  </div>
}

type Editing = { kind: 'goal' } | { kind: 'contribution'; item: Contribution | null } | null

/** `/goals/{id}`: the progress and the history; contributions and the goal itself change in a sheet. */
export default function GoalPage({ goalId }: { goalId: number }) {
  const session = useSession()
  const [load, setLoad] = useState<{ kind: 'error'; message: string } | { kind: 'ok'; goal: GoalDetail }>()
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<Editing>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void getGoal(goalId, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setLoad({ kind: 'ok', goal: result.data })
      else if (result.kind === 'error') setLoad({ kind: 'error', message: goalFailure(result) })
    })
    return () => controller.abort()
  }, [goalId, attempt])
  usePageTitle(load?.kind === 'ok' ? load.goal.name : undefined)
  if (!load) return <RequestState kind="loading" message="Загружаем цель…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  const { goal } = load
  const user = session.kind === 'user' ? session.user.username : ''
  const household = session.kind === 'user' && session.household !== null
  const today = new Date().toLocaleDateString('sv-SE')

  const run = (request: () => Promise<LocalApiResult<GoalDetail>>, done: string) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    void request().then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        setLoad({ kind: 'ok', goal: result.data })
        setEditing(null)
        setNotice(done)
      } else if (result.kind === 'error') setFailure(goalFailure(result))
    })
  }
  const saveGoal = (draft: GoalDraft) => run(() => updateGoal(goal.id, goalBody(draft, household)), 'Цель сохранена.')
  const removeGoal = () => {
    if (busy) return
    setBusy(true)
    void deleteGoal(goal.id).then((result) => {
      setBusy(false)
      if (result.kind === 'ok' || (result.kind === 'error' && result.reason === 'not_found')) navigate('/goals', { replace: true })
      else if (result.kind === 'error') setFailure(goalFailure(result))
    })
  }
  const contribution = editing?.kind === 'contribution' ? editing.item : null
  const saveContribution = (draft: ContributionDraft) => run(
    () => contribution ? updateContribution(goal.id, contribution.id, contributionBody(draft)) : addContribution(goal.id, contributionBody(draft)),
    contribution ? 'Взнос сохранён.' : 'Взнос добавлен.')
  return <>
    <GoalView goal={goal} notice={notice} onAdd={() => { setFailure(null); setEditing({ kind: 'contribution', item: null }) }}
      onEditGoal={() => { setFailure(null); setEditing({ kind: 'goal' }) }}
      onEdit={(item) => { setFailure(null); setEditing({ kind: 'contribution', item }) }} />
    <Sheet open={editing !== null} onClose={() => setEditing(null)}
      title={editing?.kind === 'goal' ? 'Изменить цель' : contribution ? 'Взнос' : 'Новый взнос'}>
      {editing?.kind === 'goal' && <GoalForm goal={goal} currency={goal.currency} household={household} busy={busy}
        failure={failure} onSubmit={saveGoal} onDelete={removeGoal} />}
      {editing?.kind === 'contribution' && <ContributionForm key={contribution?.id ?? 'new'} item={contribution} currency={goal.currency}
        people={goal.people} today={today} user={user} busy={busy} failure={failure} onSubmit={saveContribution}
        onDelete={contribution ? () => run(() => deleteContribution(goal.id, contribution.id), 'Взнос удалён.') : undefined} />}
    </Sheet>
  </>
}
