import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import logo640 from '../../assets/brand/logo-640.webp'
import logo1280 from '../../assets/brand/logo-1280.webp'
import { checkFamilyInvite, createFamilyAccount, logout } from '../../api/session'
import { Link, navigate } from '../../navigation'
import { applyMe, useSession } from '../../session'
import { ThemeToggle } from '../../theme'
import { FormMessage } from '../auth/LoginPage'
import { useAuthForm } from '../auth/auth-state'
import type { FormState } from '../auth/auth-state'
import { logoutRefusal, passwordRules, waitText } from '../auth/labels'
import { checkNewFamily, newFamilyRefusal, newFamilyTexts } from './family-state'
import type { NewFamilyValues } from './family-state'
import '../auth/Auth.css'
import './Family.css'

/** What the check of the link said: a form only for a valid invite. */
export type InviteCheck =
  | { kind: 'checking' } | { kind: 'valid'; expiresAt: string } | { kind: 'invalid'; message: string }
  | { kind: 'failed' }

export type NewFamilyViewProps = {
  check: InviteCheck
  state: FormState
  values: NewFamilyValues
  onChange: (values: NewFamilyValues) => void
  onSubmit: () => void
  onRetry: () => void
  /** The shell's `h1#page-heading`, as on the sign-in. */
  heading?: ReactNode
}

const fields: { name: keyof NewFamilyValues; label: string; type?: string; autoComplete: string; placeholder?: string; maxLength: number }[] = [
  { name: 'name', label: 'Название семьи', autoComplete: 'off', placeholder: 'Семья Ивановых', maxLength: 100 },
  { name: 'first_name', label: 'Как вас зовут', autoComplete: 'given-name', placeholder: 'необязательно', maxLength: 150 },
  { name: 'username', label: 'Логин для входа', autoComplete: 'username', placeholder: 'латиницей', maxLength: 150 },
  { name: 'password', label: 'Пароль', type: 'password', autoComplete: 'new-password', maxLength: 4096 },
]

/** The invite of a new family on the whole screen, like the sign-in: the logo above a card, the form in it. A real form:
 * a password manager offers to save the new login. The order in the markup is the Tab order. */
export function NewFamilyView({ check, state, values, onChange, onSubmit, onRetry, heading }: NewFamilyViewProps) {
  const pending = state.kind === 'pending'
  const invalid = (field: string) => (state.kind === 'failed' && state.fields.includes(field)) || undefined
  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending) onSubmit() }
  let body: ReactNode
  switch (check.kind) {
    case 'checking': body = <p className="ck-auth-hint" role="status">Проверяем приглашение…</p>; break
    case 'invalid': body = <p className="ck-auth-notice" role="alert" data-new-family-invalid>{check.message}</p>; break
    case 'failed': body = <>
      <p className="ck-auth-notice" role="alert">{newFamilyTexts.checkFailed}</p>
      <button type="button" className="ck-auth-secondary" onClick={onRetry}>Повторить</button>
    </>; break
    case 'valid': body = <form className="ck-auth-panel" method="post" noValidate onSubmit={submit} data-new-family-form>
      <p className="ck-auth-hint">
        Вы станете главным новой семьи и сможете добавить в неё людей. Ссылка одноразовая, действует
        до <time dateTime={check.expiresAt}>{new Date(check.expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</time>.
      </p>
      {fields.map((field) => <div className="ck-auth-field" key={field.name}>
        <label htmlFor={`new-family-${field.name}`}>{field.label}</label>
        <input id={`new-family-${field.name}`} name={field.name} type={field.type ?? 'text'} autoComplete={field.autoComplete}
          autoCapitalize={field.name === 'username' || field.name === 'password' ? 'none' : undefined} autoCorrect="off"
          spellCheck={field.name === 'name' || field.name === 'first_name'} maxLength={field.maxLength} placeholder={field.placeholder}
          required={field.name !== 'first_name'} aria-invalid={invalid(field.name)} value={values[field.name]}
          aria-describedby={field.name === 'password' ? 'new-family-password-rules' : undefined}
          onChange={(event) => onChange({ ...values, [field.name]: event.target.value })} />
      </div>)}
      <ul id="new-family-password-rules" className="ck-auth-rules" aria-label="Пароль">
        {Object.values(passwordRules).map((rule) => <li key={rule}>{rule}</li>)}
      </ul>
      <div className="ck-auth-actions">
        <button type="submit" className="ck-auth-primary" data-new-family-submit aria-disabled={pending || undefined}
          aria-describedby="new-family-message">{pending ? 'Создаём…' : 'Создать семью'}</button>
        <FormMessage state={state} id="new-family-message" />
      </div>
    </form>
  }
  return (
    <main id="main" className="ck-login">
      <div className="ck-login-layout">
        <div className="ck-login-board">
          <span className="ck-login-rays" aria-hidden="true" />
          <img className="ck-login-logo" src={logo640} srcSet={`${logo640} 640w, ${logo1280} 1280w`}
            sizes="(min-width: 720px) min(50vw, 520px), 152px" width="640" height="640" alt="Чекист — продуктовая разведка" />
        </div>
        <div className="ck-login-panel">
          <div className="ck-login-title">
            {heading}
            <p className="ck-login-subtitle">Приглашение в Чекист</p>
          </div>
          <section className="ck-auth" aria-labelledby="page-heading">{body}</section>
          <p className="ck-login-note">Уже есть учётная запись? <Link to="/login">Войти</Link></p>
        </div>
        <div className="ck-login-footer">
          <ThemeToggle />
        </div>
      </div>
    </main>
  )
}

/** `/family/new?token=…` for a guest: checks the link, then the form; after it — signed in, at «Семья». */
export default function NewFamilyPage({ token, heading }: { token?: string; heading?: ReactNode }) {
  const [check, setCheck] = useState<InviteCheck>(token ? { kind: 'checking' } : { kind: 'invalid', message: newFamilyTexts.noToken })
  const [attempt, setAttempt] = useState(0)
  // The password lives only in this component: never in the address, history state or storage.
  const [values, setValues] = useState<NewFamilyValues>({ name: '', first_name: '', username: '', password: '' })
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    void checkFamilyInvite(token, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setCheck({ kind: 'valid', expiresAt: result.data.expires_at })
      else if (result.kind === 'error') {
        if (result.reason === 'invite_invalid') setCheck({ kind: 'invalid', message: newFamilyTexts.invalid })
        else if (result.reason === 'login_throttled') setCheck({ kind: 'invalid', message: `Слишком много попыток. ${waitText(result.retryAfter)}` })
        else setCheck({ kind: 'failed' })
      }
    })
    return () => controller.abort()
  }, [token, attempt])
  const { state, run } = useAuthForm({
    check: checkNewFamily,
    send: (input: NewFamilyValues, signal) => createFamilyAccount({ token: token ?? '', ...input }, { signal }),
    refusal: newFamilyRefusal,
    // Signed in as the new head: «Семья» shows the family, its ИИ switch (off) and how to add people.
    success: (me) => { navigate('/family', { replace: true }); applyMe(me) },
  })
  return <NewFamilyView check={check} state={state} values={values} onChange={setValues} onSubmit={() => { void run(values) }}
    onRetry={() => { setCheck({ kind: 'checking' }); setAttempt(attempt + 1) }} heading={heading} />
}

/** The same address for a signed-in person, inside the shell: the link is for a new account, so sign out first. */
export function NewFamilySignedIn() {
  const session = useSession()
  const name = session.kind === 'user' ? session.user.display_name || session.user.username : ''
  const signOut = useAuthForm({
    send: (_input: null, signal) => logout({ signal }),
    refusal: logoutRefusal,
    // A guest: the shell shows the invite form on this very address.
    success: () => { applyMe(null) },
  })
  const leaving = signOut.state.kind === 'pending'
  return <div className="ck-auth" data-new-family="signed-in">
    <section className="ck-auth-panel" aria-labelledby="new-family-heading">
      <h2 id="new-family-heading">Приглашение в новую семью</h2>
      <p>Вы вошли как {name}. {newFamilyTexts.signedIn}</p>
      <div className="ck-auth-actions">
        <button type="button" className="ck-auth-secondary" aria-disabled={leaving || undefined} aria-describedby="new-family-logout"
          onClick={() => { void signOut.run(null) }}>{leaving ? 'Выходим…' : 'Выйти'}</button>
        <FormMessage state={signOut.state} id="new-family-logout" />
        <Link className="action-link" to="/">На главную</Link>
      </div>
    </section>
  </div>
}
