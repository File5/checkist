import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, Ref } from 'react'
import logo640 from '../../assets/brand/logo-640.webp'
import logo1280 from '../../assets/brand/logo-1280.webp'
import { Link, navigate } from '../../navigation'
import { ThemeToggle } from '../../theme'
import { createLoginFlow, fieldError, isLocked, loginMessage, unavailableHandler } from './login-state'
import type { LoginField, LoginHandler, LoginState, LoginTone } from './login-state'

const ids = {
  login: { input: 'ck-login-username', error: 'ck-login-username-error' },
  password: { input: 'ck-login-password', error: 'ck-login-password-error' },
}

/** The mark that keeps an error or a notice from being told by colour alone. */
function Mark({ tone }: { tone: LoginTone }) {
  return (
    <svg className="ck-login-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      {tone === 'success'
        ? <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-1.3 12.9L4.9 10l1.4-1.4 2.4 2.4 5-5 1.4 1.4-6.4 6.5Z" />
        : tone === 'info'
          ? <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-1 4h2v2H9V5Zm0 4h2v6H9V9Z" />
          : <path d="M10 1 0 18.5h20L10 1Zm-1 6h2v6H9V7Zm0 7.5h2v2H9v-2Z" />}
    </svg>
  )
}

function Field({ field, label, type, autoComplete, state, inputRef, onEdit }: {
  field: LoginField; label: string; type: 'text' | 'password'; autoComplete: string; state: LoginState
  inputRef?: Ref<HTMLInputElement>; onEdit: (field: LoginField, value: string) => void
}) {
  const error = fieldError(state, field)
  return (
    <div className="ck-login-field">
      <label className="ck-login-label" htmlFor={ids[field].input}>{label}</label>
      <input
        ref={inputRef}
        className="ck-login-input"
        id={ids[field].input}
        name={field === 'login' ? 'username' : 'password'}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? ids[field].error : undefined}
        onChange={(event) => onEdit(field, event.currentTarget.value)}
      />
      {error && <p className="ck-login-field-error" id={ids[field].error}><Mark tone="error" />{error}</p>}
    </div>
  )
}

export type LoginViewProps = {
  state: LoginState
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onEdit: (field: LoginField, value: string) => void
  loginRef?: Ref<HTMLInputElement>
  passwordRef?: Ref<HTMLInputElement>
}

/** The whole screen for a given state. Order in the markup is the Tab order: login, password, «Войти», link to
    the catalog, theme switch. */
export function LoginView({ state, onSubmit, onEdit, loginRef, passwordRef }: LoginViewProps) {
  const locked = isLocked(state)
  const message = loginMessage(state)
  return (
    <main className="ck-login">
      <div className="ck-login-layout">
        <div className="ck-login-board">
          <span className="ck-login-rays" aria-hidden="true" />
          <img
            className="ck-login-logo"
            src={logo640}
            srcSet={`${logo640} 640w, ${logo1280} 1280w`}
            sizes="(min-width: 720px) min(50vw, 560px), 33vh"
            width="640"
            height="640"
            alt="Чекист — продуктовая разведка"
          />
        </div>

        <div className="ck-login-panel">
          <h1 className="ck-login-title" id="page-heading" tabIndex={-1}>Чекист</h1>
          <p className="ck-login-subtitle">Продуктовая разведка</p>
          <div className="ck-login-rule" aria-hidden="true">
            <svg className="ck-login-star" viewBox="0 0 24 24" width="24" height="24" focusable="false">
              <path d="m12 1.8 2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.1l7.1-.7L12 1.8Z" />
            </svg>
          </div>
          <p className="ck-login-invite">Предъявите пропуск</p>

          {/* method="post": should the script fail, a native submission never puts the password into the address. */}
          <form className="ck-login-form" method="post" noValidate aria-label="Вход" aria-busy={state.kind === 'submitting'} onSubmit={onSubmit}>
            <Field field="login" label="Логин" type="text" autoComplete="username" state={state} inputRef={loginRef} onEdit={onEdit} />
            <Field field="password" label="Пароль" type="password" autoComplete="current-password" state={state} inputRef={passwordRef} onEdit={onEdit} />
            {/* aria-disabled, not disabled: the button keeps the keyboard focus while the form is locked;
                a repeated submission is refused by the model. */}
            <button className="ck-login-submit" type="submit" aria-disabled={locked ? true : undefined}>
              {state.kind === 'submitting' ? 'Входим…' : 'Войти'}
            </button>
            {/* Always in the document, so that a screen reader announces the message when it appears. */}
            <div className="ck-login-status" role="status">
              {message && (
                <div className={`ck-login-message ck-login-message-${message.tone}`}>
                  <Mark tone={message.tone} />
                  <p className="ck-login-message-text">
                    {message.text}
                    {message.catalogLink && <>. <Link className="ck-login-link" to="/catalog">Пройти в каталог</Link></>}
                  </p>
                </div>
              )}
            </div>
          </form>

          <p className="ck-login-note">Пропуска выдаёт администратор</p>
          <div className="ck-login-footer">
            <Link className="ck-login-link" to="/catalog">Каталог продуктов</Link>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </main>
  )
}

function enterCatalog() {
  // The login screen does not stay in the history behind the catalog.
  navigate('/catalog', { replace: true })
}

export type LoginPageProps = {
  /** Seam for the authorisation task: receives the typed login and password and resolves with the outcome.
      The default handler sends nothing and answers `unavailable` (see login-state.ts). */
  onSubmit?: LoginHandler
  /** Called once after the `ok` outcome; opens the catalog by default. */
  onEnter?: () => void
}

/** Screen `/login`: draws its own `<main>` and `h1#page-heading`; the application adds no shell around it. */
export function LoginPage({ onSubmit = unavailableHandler, onEnter = enterCatalog }: LoginPageProps) {
  const [flow] = useState(createLoginFlow)
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot)
  const loginInput = useRef<HTMLInputElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  // A new object on every refused submission: the focus returns to the empty field each time.
  const [focusRequest, setFocusRequest] = useState<{ field: LoginField }>()

  useEffect(() => {
    if (focusRequest) (focusRequest.field === 'login' ? loginInput : passwordInput).current?.focus()
  }, [focusRequest])

  // The fields are uncontrolled: the password lives only in its input and is read at the moment of submission.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const { focus } = flow.submit(loginInput.current?.value ?? '', passwordInput.current?.value ?? '', onSubmit, onEnter)
    if (focus) setFocusRequest({ field: focus })
  }

  return <LoginView state={state} onSubmit={submit} onEdit={flow.edit} loginRef={loginInput} passwordRef={passwordInput} />
}

export default LoginPage
