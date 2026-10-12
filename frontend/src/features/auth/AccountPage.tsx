import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { changePassword, logout } from '../../api/session'
import { Link } from '../../navigation'
import { applyMe, useSession } from '../../session'
import SettingsSection from './SettingsSection'
import { checkPassword, useAuthForm } from './auth-state'
import type { FormState, PasswordInput } from './auth-state'
import { logoutRefusal, passwordChangedText, passwordRefusal, passwordRules } from './labels'
import { FormMessage } from './LoginPage'

const emptyPassword: PasswordInput = { current_password: '', new_password: '', repeat: '' }

export type AccountViewProps = {
  username: string
  password: FormState
  values: PasswordInput
  onChange: (values: PasswordInput) => void
  onPassword: () => void
  signOut: FormState
  onSignOut: () => void
  /** «Настройки» between the user and the export; the page passes the live section. */
  settings?: ReactNode
}

export function AccountView({ username, password, values, onChange, onPassword, signOut, onSignOut, settings }: AccountViewProps) {
  const saving = password.kind === 'pending'
  const leaving = signOut.kind === 'pending'
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
    <div className="ck-auth">
      <section className="ck-auth-panel" aria-labelledby="account-user-heading">
        <h2 id="account-user-heading">Пользователь</h2>
        <p className="ck-auth-username" data-auth-username>{username}</p>
        <div className="ck-auth-actions">
          <button type="button" className="ck-auth-secondary" data-auth-logout aria-disabled={leaving || undefined} aria-describedby="logout-message"
            onClick={leaving ? undefined : onSignOut}>{leaving ? 'Выходим…' : 'Выйти'}</button>
          <FormMessage state={signOut} id="logout-message" />
        </div>
      </section>
      {settings}
      <section className="ck-auth-panel" aria-labelledby="account-export-heading">
        <h2 id="account-export-heading">Выгрузка данных</h2>
        <p>Все чеки и траты семьи файлом JSON, с фильтрами по периоду, категориям и людям.</p>
        <Link className="action-link" to="/export" data-auth-export>Выгрузить в JSON</Link>
      </section>
      <section className="ck-auth-panel" aria-labelledby="account-family-heading">
        <h2 id="account-family-heading">Семья</h2>
        <p>Члены семьи видят траты друг друга. Здесь создают семью, добавляют людей и передают роль главного.</p>
        <Link className="action-link" to="/family" data-auth-family>Открыть «Семью»</Link>
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
            <button type="submit" data-auth-submit aria-disabled={saving || undefined} aria-describedby="password-message">{saving ? 'Сохраняем…' : 'Сменить пароль'}</button>
            <FormMessage state={password} id="password-message" />
          </div>
        </form>
      </section>
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
  return <AccountView username={username} settings={<SettingsSection displayName={displayName} />} password={password.state} values={values} onChange={setValues} onPassword={() => { void password.run(values) }}
    signOut={signOut.state} onSignOut={() => { void signOut.run(null) }} />
}
