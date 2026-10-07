/* Standalone preview of the `/login` screen (preview/index.html): the real LoginPage with a strip above it that
   chooses what the sign-in handler answers. There is no server and no application around it, so the links to the
   catalog lead nowhere; nothing here is used by the application. */
import { useState } from 'react'
import { LoginPage } from '../index.tsx'
import { loginOutcomes } from '../login-state.ts'
import type { LoginHandler, LoginOutcome } from '../login-state.ts'

const labels: Record<LoginOutcome, string> = {
  unavailable: 'unavailable — вход не подключён',
  invalid: 'invalid — неверный логин или пароль',
  throttled: 'throttled — слишком много попыток',
  network: 'network — нет связи с сервером',
  ok: 'ok — вход выполнен',
}
const strip = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', padding: '10px 16px',
  borderBottom: '1px dashed var(--ck-border-field)', background: 'var(--ck-surface)', color: 'var(--ck-text)',
  fontFamily: 'var(--ck-font-body)', fontSize: '0.9rem',
} as const
const control = {
  minHeight: 36, padding: '4px 8px', border: '1px solid var(--ck-border-field)', borderRadius: 'var(--ck-radius-sm)',
  background: 'var(--ck-surface)', color: 'var(--ck-text)', font: 'inherit', maxWidth: '100%',
} as const

export default function LoginDemo() {
  const [choice, setChoice] = useState<'default' | LoginOutcome>('default')
  const [screen, setScreen] = useState(0)
  const [entered, setEntered] = useState(0)
  // «default» leaves the application's own handler: no request, the `unavailable` outcome at once.
  const handler: LoginHandler | undefined = choice === 'default' ? undefined
    : () => new Promise((resolve) => { window.setTimeout(() => resolve(choice), 1500) })
  return (
    <>
      <div style={strip}>
        <span>Превью экрана входа: настоящий компонент, сервера нет.</span>
        <label>
          Ответ на «Войти»:{' '}
          <select style={control} value={choice} onChange={(event) => setChoice(event.currentTarget.value as 'default' | LoginOutcome)}>
            <option value="default">как в приложении сейчас (без запроса)</option>
            {loginOutcomes.map((outcome) => <option key={outcome} value={outcome}>{labels[outcome]}, через 1,5 с</option>)}
          </select>
        </label>
        <button type="button" style={{ ...control, cursor: 'pointer' }} onClick={() => setScreen((value) => value + 1)}>Сбросить экран</button>
        {entered > 0 && <span>Переходов в каталог: {entered} (в превью каталога нет).</span>}
      </div>
      <LoginPage key={screen} onSubmit={handler} onEnter={() => setEntered((value) => value + 1)} />
    </>
  )
}
