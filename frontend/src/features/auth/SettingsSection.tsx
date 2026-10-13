import { useEffect, useState } from 'react'
import { getSettings, saveSettings } from '../../api/settings'
import type { CurrencyOption } from '../../api/settings'
import { applySettings, isHead, useSession } from '../../session'
import { settingsTexts } from './settings-texts'

/** The state of «Настройки»: loading, the loaded values, a save in flight, and the last notice. */
export type SettingsState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; currencies: CurrencyOption[]; currency: string | null; saving: boolean; notice: SettingsNotice | null
    /** The family's base currency from the server; missing from an older one. */
    base?: string }
export type SettingsNotice = { kind: 'saved' | 'failed'; text: string }


export type SettingsViewProps = {
  state: SettingsState; onCurrency: (code: string | null) => void
  /** In a family and its head: how the base currency of the family is chosen. */
  family?: boolean; head?: boolean
}

export function SettingsView({ state, onCurrency, family = false, head = true }: SettingsViewProps) {
  return (
    <section className="ck-auth-panel" aria-labelledby="account-settings-heading" data-account-settings>
      <h2 id="account-settings-heading">{settingsTexts.heading}</h2>
      {state.kind === 'loading' && <p className="ck-auth-hint" role="status">Загружаем…</p>}
      {state.kind === 'failed' && <p className="ck-auth-error" role="alert">{settingsTexts.loadFailed}</p>}
      {state.kind === 'ready' && (
        <div className="ck-auth-field">
          <label htmlFor="account-default-currency">{settingsTexts.currency}</label>
          <select id="account-default-currency" data-settings-currency value={state.currency ?? ''} aria-describedby="account-currency-hint account-settings-notice"
            aria-disabled={state.saving || undefined}
            onChange={(event) => { if (!state.saving) onCurrency(event.target.value || null) }}>
            <option value="">{settingsTexts.none}</option>
            {state.currencies.map((item) => <option key={item.code} value={item.code}>{item.code} — {item.name}</option>)}
          </select>
          <p id="account-currency-hint" className="ck-auth-hint">{settingsTexts.currencyHint}</p>
          {state.base && <p className="ck-auth-hint" data-settings-base>{settingsTexts.base(state.base, family, head)}</p>}
          <p id="account-settings-notice" className={state.notice?.kind === 'failed' ? 'ck-auth-error' : 'ck-auth-done'} role="status" data-settings-notice={state.notice?.kind}>{state.notice?.text ?? ''}</p>
        </div>
      )}
    </section>
  )
}

/** «Настройки» on `/account`: the choice is saved at once, the session learns the new value. */
export default function SettingsSection() {
  const session = useSession()
  const [state, setState] = useState<SettingsState>({ kind: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    void getSettings({ signal: controller.signal }).then((result) => {
      if (result.kind === 'aborted') return
      setState(result.kind === 'ok'
        ? { kind: 'ready', currencies: result.data.currencies, currency: result.data.default_currency, saving: false, notice: null,
          base: result.data.base_currency }
        : { kind: 'failed' })
    })
    return () => controller.abort()
  }, [])
  const choose = (code: string | null) => {
    if (state.kind !== 'ready') return
    const previous = state.currency
    setState({ ...state, currency: code, saving: true, notice: null })
    void saveSettings({ default_currency: code }).then((result) => {
      if (result.kind === 'aborted') return
      if (result.kind === 'ok') {
        applySettings(result.data)
        setState((current) => current.kind === 'ready'
          ? { ...current, currency: result.data.default_currency, saving: false, notice: { kind: 'saved', text: settingsTexts.saved(result.data.default_currency) },
            base: result.data.base_currency }
          : current)
      } else {
        setState((current) => current.kind === 'ready'
          ? { ...current, currency: previous, saving: false, notice: { kind: 'failed', text: settingsTexts.saveFailed } }
          : current)
      }
    })
  }
  return <SettingsView state={state} onCurrency={choose}
    family={session.kind === 'user' && session.household !== null} head={isHead(session)} />
}
