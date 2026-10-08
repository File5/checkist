import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import logo640 from '../../assets/brand/logo-640.webp'
import logo1280 from '../../assets/brand/logo-1280.webp'
import { login } from '../../api/session'
import { applyMe } from '../../session'
import { ThemeToggle } from '../../theme'
import { checkLogin, useAuthForm } from './auth-state'
import type { FormState, LoginInput } from './auth-state'
import { loginRefusal, sessionExpiredText } from './labels'

/** The result of a form next to its button. A refusal is rendered once; the region itself always exists. */
export function FormMessage({ state, id }: { state: FormState; id: string }) {
  return (
    <div id={id} className="ck-auth-message" aria-live="polite">
      {state.kind === 'failed' && <div className="ck-auth-error" data-auth-error>
        <p>{state.message}</p>
        {state.details.length > 0 && <ul>{state.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
      </div>}
      {state.kind === 'done' && <p className="ck-auth-done" data-auth-done>{state.message}</p>}
    </div>
  )
}

export type LoginViewProps = {
  state: FormState
  expired: boolean
  values: LoginInput
  onChange: (values: LoginInput) => void
  onSubmit: () => void
  /** The shell's `h1#page-heading`: it names the form and takes the focus when the screen opens. */
  heading?: ReactNode
}

/** The sign-in on the address the person opened: the whole screen with its own `<main>`, no shell around it.
    A real form: a password manager offers to save and to fill it. The order in the markup is the Tab order:
    name, password, «Войти», theme switch. */
export function LoginView({ state, expired, values, onChange, onSubmit, heading }: LoginViewProps) {
  const pending = state.kind === 'pending'
  const invalid = (field: string) => (state.kind === 'failed' && state.fields.includes(field)) || undefined
  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending) onSubmit() }
  return (
    <main id="main" className="ck-login">
      <div className="ck-login-layout">
        <div className="ck-login-board">
          <span className="ck-login-rays" aria-hidden="true" />
          <img className="ck-login-logo" src={logo640} srcSet={`${logo640} 640w, ${logo1280} 1280w`}
            sizes="(min-width: 720px) min(50vw, 560px), 33vh" width="640" height="640" alt="Чекист — продуктовая разведка" />
        </div>
        <div className="ck-login-panel">
          {heading}
          <p className="ck-login-subtitle">Продуктовая разведка</p>
          <div className="ck-login-rule" aria-hidden="true">
            <svg className="ck-login-star" viewBox="0 0 24 24" width="24" height="24" focusable="false">
              <path d="m12 1.8 2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.1l7.1-.7L12 1.8Z" />
            </svg>
          </div>
          <p className="ck-login-invite">Предъявите пропуск</p>
          <section className="ck-auth" aria-labelledby="page-heading">
            {expired && <p className="ck-auth-notice" data-auth-expired>{sessionExpiredText}</p>}
            <form className="ck-auth-panel" method="post" noValidate onSubmit={submit}>
              <div className="ck-auth-field">
                <label htmlFor="login-username">Имя пользователя</label>
                <input id="login-username" name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  maxLength={150} required aria-invalid={invalid('username')} value={values.username}
                  onChange={(event) => onChange({ ...values, username: event.target.value })} />
              </div>
              <div className="ck-auth-field">
                <label htmlFor="login-password">Пароль</label>
                <input id="login-password" name="password" type="password" autoComplete="current-password" required
                  aria-invalid={invalid('password')} value={values.password}
                  onChange={(event) => onChange({ ...values, password: event.target.value })} />
              </div>
              <div className="ck-auth-actions">
                {/* Not `disabled`: the button keeps focus during the request; the form state refuses a second press. */}
                <button type="submit" data-auth-submit aria-disabled={pending || undefined} aria-describedby="login-message">{pending ? 'Входим…' : 'Войти'}</button>
                <FormMessage state={state} id="login-message" />
              </div>
            </form>
          </section>
          <p className="ck-login-note">Пропуска выдаёт администратор</p>
          <div className="ck-login-footer">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </main>
  )
}

export default function LoginPage({ expired, heading }: { expired: boolean; heading?: ReactNode }) {
  // The password lives only in this component: never in the address, history state or storage.
  const [values, setValues] = useState<LoginInput>({ username: '', password: '' })
  const { state, run } = useAuthForm({
    check: checkLogin,
    send: (input: LoginInput, signal) => login({ username: input.username, password: input.password }, { signal }),
    refusal: loginRefusal,
    // The shell opens the page of the same address as soon as the session has a user.
    success: (me) => { applyMe(me) },
  })
  return <LoginView state={state} expired={expired} values={values} onChange={setValues} onSubmit={() => { void run(values) }} heading={heading} />
}
