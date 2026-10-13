import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { changePassword, logout } from '../../api/session'
import { initials } from '../../lib/people'
import { Link } from '../../navigation'
import { applyMe, isHead, useSession } from '../../session'
import { useTheme } from '../../theme'
import type { Theme } from '../../theme'
import SettingsSection from './SettingsSection'
import PushSection from '../push/PushSection'
import { checkPassword, useAuthForm } from './auth-state'
import type { FormState, PasswordInput } from './auth-state'
import { settingsTexts } from './settings-texts'
import { logoutRefusal, passwordChangedText, passwordRefusal, passwordRules } from './labels'
import { FormMessage } from './LoginPage'

const emptyPassword: PasswordInput = { current_password: '', new_password: '', repeat: '' }

export type AccountViewProps = {
  username: string
  /** «Имя» from the admin; the login when it is empty. */
  displayName?: string
  /** The family of the person and whether they head it; nothing — no family. */
  family?: { name: string; head: boolean } | null
  password: FormState
  values: PasswordInput
  onChange: (values: PasswordInput) => void
  onPassword: () => void
  signOut: FormState
  onSignOut: () => void
  /** «Настройки» under the person; the page passes the live section. */
  settings?: ReactNode
}

/** A chevron at the end of a row that leads to another page. */
export function Chevron() {
  return <svg className="ck-auth-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
}

const themeNames: [Theme, string][] = [['light', 'Светлая'], ['dark', 'Тёмная']]

/** The theme as two segments: the chosen one is pressed. The same choice as the switch of the header. */
function ThemeChoice() {
  const { theme, setTheme } = useTheme()
  return <div className="ck-auth-segments" role="group" aria-labelledby="account-theme-label">
    {themeNames.map(([value, name]) => <button key={value} type="button" className="ck-auth-segment" aria-pressed={theme === value}
      onClick={() => setTheme(value)}>{name}</button>)}
  </div>
}

export function AccountView({ username, displayName, family, password, values, onChange, onPassword, signOut, onSignOut, settings }: AccountViewProps) {
  const saving = password.kind === 'pending'
  const leaving = signOut.kind === 'pending'
  const name = displayName?.trim() || username
  const invalid = (field: string) => (password.kind === 'failed' && password.fields.includes(field)) || undefined
  const submit = (event: FormEvent) => { event.preventDefault(); if (!saving) onPassword() }
  const field = (name: keyof PasswordInput, label: string, autoComplete: string, describedBy?: string) => (
    <div className="ck-auth-field">
      <label htmlFor={`account-${name}`}>{label}</label>
      <input id={`account-${name}`} name={name} type="password" autoComplete={autoComplete} required aria-invalid={invalid(name)}
        aria-describedby={describedBy} value={values[name]} onChange={(event) => onChange({ ...values, [name]: event.target.value })} />
    </div>
  )
  return (
    <div className="ck-auth" data-account>
      <section className="ck-auth-panel" aria-labelledby="account-user-heading">
        <div className="ck-auth-profile">
          <span className="ck-auth-avatar" aria-hidden="true">{initials(name)}</span>
          <div className="ck-auth-profile-text">
            <h2 id="account-user-heading" className="ck-auth-profile-name">{name}</h2>
            <p className="ck-auth-username" data-auth-username>{username}</p>
            {family && <p className="ck-auth-hint" data-auth-family-name>{family.name} · {family.head ? 'главный' : 'член семьи'}</p>}
            <p className="ck-auth-hint">{settingsTexts.name}</p>
          </div>
        </div>
      </section>
      {settings}
      <section className="ck-auth-panel ck-auth-list" aria-label="Оформление и данные">
        <ul className="ck-auth-rows">
          <li className="ck-auth-row">
            <span id="account-theme-label" className="ck-auth-row-label">Тема</span>
            <ThemeChoice />
          </li>
          <li>
            <Link className="ck-auth-row" to="/family" data-auth-family>
              <span className="ck-auth-row-text"><span className="ck-auth-row-label">Семья</span>
                <span className="ck-auth-row-meta">Люди, приглашения, роль главного</span></span>
              <Chevron />
            </Link>
          </li>
          <li>
            <Link className="ck-auth-row" to="/export" data-auth-export>
              <span className="ck-auth-row-text"><span className="ck-auth-row-label">Выгрузка в JSON</span>
                <span className="ck-auth-row-meta">Все чеки и траты семьи одним файлом</span></span>
              <Chevron />
            </Link>
          </li>
        </ul>
      </section>
      <section aria-labelledby="account-password-heading">
        <form className="ck-auth-panel" method="post" noValidate onSubmit={submit}>
          <h2 id="account-password-heading">Смена пароля</h2>
          {/* Lets a password manager attach the new password to the right account. */}
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          {field('current_password', 'Текущий пароль', 'current-password')}
          {field('new_password', 'Новый пароль', 'new-password', 'account-password-rules')}
          <ul id="account-password-rules" className="ck-auth-rules">
            {Object.values(passwordRules).map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
          {field('repeat', 'Новый пароль ещё раз', 'new-password')}
          <div className="ck-auth-actions">
            <button type="submit" className="ck-auth-primary" data-auth-submit aria-disabled={saving || undefined} aria-describedby="password-message">{saving ? 'Сохраняем…' : 'Сменить пароль'}</button>
            <FormMessage state={password} id="password-message" />
          </div>
        </form>
      </section>
      <div className="ck-auth-actions">
        <button type="button" className="ck-auth-danger" data-auth-logout aria-disabled={leaving || undefined} aria-describedby="logout-message"
          onClick={leaving ? undefined : onSignOut}>{leaving ? 'Выходим…' : 'Выйти из аккаунта'}</button>
        <FormMessage state={signOut} id="logout-message" />
      </div>
    </div>
  )
}

export default function AccountPage({ username }: { username: string }) {
  const [values, setValues] = useState<PasswordInput>(emptyPassword)
  const password = useAuthForm({
    check: checkPassword,
    send: (input: PasswordInput, signal) => changePassword({ current_password: input.current_password, new_password: input.new_password }, { signal }),
    refusal: passwordRefusal,
    // This session stays signed in; the typed passwords are not kept after the change.
    success: (me) => { applyMe(me); setValues(emptyPassword); return passwordChangedText },
  })
  const signOut = useAuthForm({
    send: (_input: null, signal) => logout({ signal }),
    refusal: logoutRefusal,
    // A guest: the shell shows the sign-in in place of this page.
    success: () => { applyMe(null) },
  })
  const session = useSession()
  const displayName = session.kind === 'user' ? session.user.display_name || username : username
  const family = session.kind === 'user' && session.household ? { name: session.household.name, head: isHead(session) } : null
  return <AccountView username={username} displayName={displayName} family={family} settings={<><SettingsSection /><PushSection /></>} password={password.state} values={values}
    onChange={setValues} onPassword={() => { void password.run(values) }}
    signOut={signOut.state} onSignOut={() => { void signOut.run(null) }} />
}
