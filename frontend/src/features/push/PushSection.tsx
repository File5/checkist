import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getPush, savePush, subscribePush, testPush, unsubscribePush, pushKinds } from '../../api/push'
import type { PushKind, PushState, PushSubscriptionBody } from '../../api/push'
import type { LocalApiResult } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { DeviceRefusal, deviceSubscription, pushSupport, readDevice, subscribeDevice, unsubscribeDevice } from './push-device'
import type { PushSupport } from './push-device'
import { pushTexts } from './push-texts'
import './Push.css'

export type PushNotice = { kind: 'done' | 'failed'; text: string }
export type PushSectionState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; push: PushState; support: PushSupport; denied: boolean
    /** This browser holds a subscription the server knows. */
    device: boolean; busy: boolean; notice: PushNotice | null }

const kindTexts: Record<PushKind, [string, (push: PushState) => string]> = {
  recurring: ['Регулярные платежи', () => 'За 1–2 дня до срока и когда платёж просрочен'],
  limits: ['Лимиты', () => 'Когда потрачено 80\u00a0% и 100\u00a0% лимита за месяц'],
  weekly: ['Итоги недели', () => 'В воскресенье вечером: сколько потрачено за неделю'],
  monthly: ['Разбор месяца', () => '1-го числа: итоги прошлого месяца'],
  large: ['Крупные траты семьи', (push) => `Когда другой член семьи тратит от ${formatMoney(push.settings.large_threshold, push.base_currency)}`],
}

export type PushViewProps = {
  state: PushSectionState
  onDevice: (on: boolean) => void
  onKind: (kind: PushKind, on: boolean) => void
  onThreshold: (value: string) => void
  onTest: () => void
}

function deviceMeta(state: Extract<PushSectionState, { kind: 'ready' }>): string {
  if (state.support === 'unsupported') return pushTexts.unsupported
  return state.device ? pushTexts.on : pushTexts.off
}

export function PushView({ state, onDevice, onKind, onThreshold, onTest }: PushViewProps) {
  const [threshold, setThreshold] = useState<string | null>(null)
  const ready = state.kind === 'ready' ? state : null
  const busy = ready?.busy ?? false
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && threshold !== null) onThreshold(threshold)
  }
  return (
    <section className="ck-panel push-panel" aria-labelledby="push-heading" data-push>
      <div className="ck-panel-head"><h2 id="push-heading">{pushTexts.heading}</h2></div>
      {state.kind === 'loading' && <p className="ck-auth-hint" role="status">Загружаем…</p>}
      {state.kind === 'failed' && <p className="ck-auth-error" role="alert">{pushTexts.loadFailed}</p>}
      {ready && !ready.push.configured && <p className="ck-auth-hint" data-push-off>{pushTexts.notConfigured}</p>}
      {ready && ready.push.configured && <>
        <div className="push-device">
          <div className="ck-row-main">
            <span className="ck-row-title">{pushTexts.device}</span>
            <span className="ck-row-meta" data-push-device={ready.device ? 'on' : 'off'}>{deviceMeta(ready)}</span>
          </div>
          {ready.support === 'install' && <p className="ck-auth-notice" data-push-install>{pushTexts.install}</p>}
          {ready.denied && !ready.device && <p className="ck-auth-hint" data-push-denied>{pushTexts.denied}</p>}
          {ready.support === 'ready' && (ready.device
            ? <button type="button" className="ck-button-secondary" aria-disabled={busy || undefined}
              onClick={busy ? undefined : () => onDevice(false)} data-push-disable>{pushTexts.disable}</button>
            : <button type="button" aria-disabled={busy || undefined}
              onClick={busy ? undefined : () => onDevice(true)} data-push-enable>{pushTexts.enable}</button>)}
          {ready.push.devices > 0 && <p className="ck-auth-hint">{pushTexts.devices(ready.push.devices)}</p>}
        </div>
        <ul className="ck-list" aria-label="Поводы">
          {pushKinds.map((kind) => {
            const [title, meta] = kindTexts[kind]
            const on = ready.push.settings[kind]
            return <li key={kind}>
              <div className="ck-row">
                <div className="ck-row-main">
                  <span className="ck-row-title" id={`push-${kind}`}>{title}</span>
                  <span className="ck-row-meta" id={`push-${kind}-meta`}>{meta(ready.push)}</span>
                </div>
                <button type="button" role="switch" className="push-switch" aria-checked={on} aria-labelledby={`push-${kind}`}
                  aria-describedby={`push-${kind}-meta`} aria-disabled={busy || undefined} data-push-kind={kind}
                  onClick={busy ? undefined : () => onKind(kind, !on)}><span className="push-switch-thumb" /></button>
              </div>
              {kind === 'large' && on && (
                <form className="push-threshold" noValidate onSubmit={submit}>
                  <div className="ck-auth-field">
                    <label htmlFor="push-threshold">{pushTexts.threshold}, {ready.push.base_currency}</label>
                    <input id="push-threshold" inputMode="decimal" autoComplete="off" data-push-threshold
                      value={threshold ?? ready.push.settings.large_threshold.replace(/\.00$/, '')}
                      onChange={(event) => setThreshold(event.target.value)} />
                  </div>
                  <button type="submit" className="ck-button-secondary" aria-disabled={busy || undefined}>{pushTexts.thresholdSave}</button>
                </form>
              )}
            </li>
          })}
        </ul>
        <p className="ck-auth-hint">{pushTexts.quiet}</p>
        <button type="button" className="ck-button-secondary" aria-disabled={busy || undefined}
          onClick={busy ? undefined : onTest} data-push-test>{pushTexts.test}</button>
      </>}
      <p className={ready?.notice?.kind === 'failed' ? 'ck-auth-error' : 'ck-auth-done'} role="status" data-push-notice={ready?.notice?.kind}>
        {ready?.notice?.text ?? ''}</p>
    </section>
  )
}

/** «Уведомления» on `/account`: this device, the five reasons, the test notification. */
export default function PushSection() {
  const [state, setState] = useState<PushSectionState>({ kind: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    const support = pushSupport(readDevice())
    void (async () => {
      const result = await getPush({ signal: controller.signal })
      if (result.kind === 'aborted') return
      if (result.kind !== 'ok') { setState({ kind: 'failed' }); return }
      let push = result.data
      const subscription = support === 'ready' && push.configured ? await deviceSubscription().catch(() => null) : null
      // The browser keeps a subscription: the server learns it again (it may have dropped it, or another person used
      // this device before), so this device belongs to the person who is signed in now.
      if (subscription) {
        const again = await subscribePush(subscription.toJSON() as PushSubscriptionBody, { signal: controller.signal })
        if (again.kind === 'aborted') return
        if (again.kind === 'ok') push = again.data
      }
      setState({ kind: 'ready', push, support, denied: support === 'ready' && Notification.permission === 'denied',
        device: subscription !== null, busy: false, notice: null })
    })()
    return () => controller.abort()
  }, [])

  const run = async (change: (ready: Extract<PushSectionState, { kind: 'ready' }>) => Promise<Partial<Extract<PushSectionState, { kind: 'ready' }>>>) => {
    if (state.kind !== 'ready' || state.busy) return
    setState({ ...state, busy: true, notice: null })
    const patch = await change(state)
    setState((current) => current.kind === 'ready' ? { ...current, busy: false, ...patch } : current)
  }
  const answer = (result: LocalApiResult<PushState>, done: string | null, extra = {}) => result.kind === 'ok'
    ? { push: result.data, notice: done ? { kind: 'done' as const, text: done } : null, ...extra }
    : { notice: { kind: 'failed' as const, text: result.kind === 'error' && result.reason === 'push_not_configured' ? pushTexts.notConfigured : pushTexts.saveFailed } }

  const onDevice = (on: boolean) => void run(async (ready) => {
    try {
      if (!on) {
        const endpoint = await unsubscribeDevice()
        return endpoint ? answer(await unsubscribePush(endpoint), pushTexts.disabled, { device: false }) : { device: false }
      }
      const body = await subscribeDevice(ready.push.public_key ?? '')
      return answer(await subscribePush(body), pushTexts.enabled, { device: true, denied: false })
    } catch (error) {
      if (error instanceof DeviceRefusal) {
        return error.reason === 'denied' ? { denied: true } : { notice: { kind: 'failed', text: pushTexts.noWorker } }
      }
      return { notice: { kind: 'failed', text: pushTexts.enableFailed } }
    }
  })
  const onKind = (kind: PushKind, on: boolean) => void run(async () => answer(await savePush({ [kind]: on }), null))
  const onThreshold = (value: string) => void run(async () => answer(
    await savePush({ large_threshold: value.replace(/\s/g, '').replace(',', '.') }), pushTexts.thresholdSaved))
  const onTest = () => void run(async () => {
    const result = await testPush()
    return result.kind === 'ok'
      ? { push: result.data, notice: { kind: 'done', text: result.data.sent > 0 ? pushTexts.testSent : pushTexts.testNone } }
      : answer(result, null)
  })
  return <PushView state={state} onDevice={onDevice} onKind={onKind} onThreshold={onThreshold} onTest={onTest} />
}
