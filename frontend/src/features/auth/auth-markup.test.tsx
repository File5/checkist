import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountView } from './AccountPage'
import type { AccountViewProps } from './AccountPage'
import type { FormState } from './auth-state'
import { passwordChangedText, passwordRefusal, sessionExpiredText } from './labels'
import LoginPage, { LoginView } from './LoginPage'
import type { LoginViewProps } from './LoginPage'

const idle: FormState = { kind: 'idle' }
const failed = (message: string, fields: string[] = [], details: string[] = []): FormState => ({ kind: 'failed', message, fields, details })
const count = (html: string, text: string) => html.split(text).length - 1
/** One field's tag in lower case: the spelling of attribute names is the renderer's business, not the form's. */
const tag = (html: string, id: string) => (html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '').toLowerCase()
/** The form's tag in lower case: the renderer writes `method` after the other attributes, so their order is not asserted. */
const formTag = (html: string) => (html.match(/<form\b[^>]*>/)?.[0] ?? '').toLowerCase()

function loginHtml(props: Partial<LoginViewProps> = {}) {
  return renderToStaticMarkup(<LoginView state={idle} expired={false} values={{ username: '', password: '' }} onChange={() => {}} onSubmit={() => {}} {...props} />)
}
function accountHtml(props: Partial<AccountViewProps> = {}) {
  return renderToStaticMarkup(<AccountView username="synthetic-reader" password={idle} signOut={idle}
    values={{ current_password: '', new_password: '', repeat: '' }} onChange={() => {}} onPassword={() => {}} onSignOut={() => {}} {...props} />)
}

describe('sign-in form (Node server markup, not browser behavior)', () => {
  it('is a real form with labelled fields a password manager recognizes', () => {
    const html = loginHtml()
    expect(html.match(/<form\b/g)).toHaveLength(1)
    expect(formTag(html)).toContain(' class="ck-auth-panel"')
    expect(formTag(html)).toContain(' method="post"')
    expect(html).toContain('<label for="login-username">Имя пользователя</label>')
    expect(html).toContain('<label for="login-password">Пароль</label>')
    expect(tag(html, 'login-username')).toContain('name="username"')
    expect(tag(html, 'login-username')).toContain('type="text"')
    expect(tag(html, 'login-username')).toContain('autocomplete="username"')
    expect(tag(html, 'login-password')).toContain('name="password"')
    expect(tag(html, 'login-password')).toContain('type="password"')
    expect(tag(html, 'login-password')).toContain('autocomplete="current-password"')
    expect(html).toContain('<button type="submit" data-auth-submit="true" aria-describedby="login-message">Войти</button>')
    expect(html).toContain('<div id="login-message" class="ck-auth-message" aria-live="polite"></div>')
  })
  it('leaves the only h1 to the shell', () => {
    expect(loginHtml()).not.toMatch(/<h1\b/)
    expect(accountHtml()).not.toMatch(/<h1\b/)
  })
  it('never renders the typed password outside its field and never puts it into a link', () => {
    const html = loginHtml({ values: { username: 'synthetic-reader', password: 'synthetic-secret' } })
    expect(count(html, 'synthetic-secret')).toBe(1)
    expect(tag(html, 'login-password')).toContain('value="synthetic-secret"')
    expect(html).not.toMatch(/href="[^"]*synthetic/)
    expect(html).not.toContain('action=')
  })
  it('explains an ended session only when it ended in the middle of work', () => {
    expect(loginHtml()).not.toContain(sessionExpiredText)
    expect(sessionExpiredText).toBe('Сеанс завершён. Войдите снова.')
    const html = loginHtml({ expired: true })
    expect(count(html, sessionExpiredText)).toBe(1)
    expect(html).toContain('data-auth-expired="true"')
  })
  it('shows a refusal exactly once, next to the button', () => {
    const html = loginHtml({ state: failed('Неверное имя пользователя или пароль.') })
    expect(count(html, 'Неверное имя пользователя или пароль.')).toBe(1)
    expect(html.match(/data-auth-error/g)).toHaveLength(1)
    expect(html).toMatch(/<button[^>]*>Войти<\/button><div id="login-message"[^>]*><div class="ck-auth-error" data-auth-error="true"><p>Неверное/)
    expect(html).not.toContain('aria-invalid')
  })
  it('marks the fields refused before the request', () => {
    const html = loginHtml({ state: failed('Введите имя пользователя и пароль.', ['password']) })
    expect(tag(html, 'login-password')).toContain('aria-invalid="true"')
    expect(tag(html, 'login-username')).not.toContain('aria-invalid')
  })
  it('keeps the button focusable during the request', () => {
    const html = loginHtml({ state: { kind: 'pending' } })
    expect(html).toContain('<button type="submit" data-auth-submit="true" aria-disabled="true" aria-describedby="login-message">Входим…</button>')
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/)
  })
  it('is the whole screen: its own main around the shell heading, without header, menu, footer or links', () => {
    // React puts an image preload hint in front of the server markup; the screen itself is one <main>.
    const html = loginHtml({ heading: <h1 id="page-heading" tabIndex={-1}>Вход</h1> }).replace(/^<link rel="preload" as="image"[^>]*\/>/, '')
    expect(html.startsWith('<main id="main" class="ck-login">')).toBe(true)
    expect(html.endsWith('</main>')).toBe(true)
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).toContain('<div class="ck-login-panel"><h1 id="page-heading" tabindex="-1">Вход</h1><p class="ck-login-subtitle">')
    expect(html).toContain('<section class="ck-auth" aria-labelledby="page-heading">')
    expect(html).not.toMatch(/<header\b|<nav\b|<footer\b|<a\b/)
  })
  it('shows the logo in two sizes with its text alternative, before the form', () => {
    const html = loginHtml()
    const image = html.match(/<img[^>]*>/)?.[0] ?? ''
    expect(html.match(/<img\b/g)).toHaveLength(1)
    expect(image).toContain('class="ck-login-logo"')
    expect(image).toContain('alt="Чекист — продуктовая разведка"')
    expect(image).toMatch(/src="[^"]*logo-640[^"]*\.webp"/)
    expect(image).toMatch(/srcSet="[^"]*logo-640[^"]*\.webp 640w, [^"]*logo-1280[^"]*\.webp 1280w"/)
    expect(image).toContain('sizes="(min-width: 720px) min(50vw, 560px), 33vh"')
    expect(image).toContain('width="640"')
    expect(image).toContain('height="640"')
    // One column on a phone follows the markup: the board first, the form under it.
    expect(html.indexOf('class="ck-login-board"')).toBeLessThan(html.indexOf('class="ck-login-panel"'))
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('<form'))
  })
  it('words the screen: motto, invitation and the note under the form', () => {
    const html = loginHtml()
    expect(html).toContain('<p class="ck-login-subtitle">Продуктовая разведка</p>')
    expect(html).toContain('<p class="ck-login-invite">Предъявите пропуск</p>')
    expect(html).toContain('<p class="ck-login-note">Пропуска выдаёт администратор</p>')
    expect(html.indexOf('ck-login-invite')).toBeLessThan(html.indexOf('<form'))
    expect(html.indexOf('ck-login-note')).toBeGreaterThan(html.indexOf('</form>'))
    expect(html).not.toContain('Вход пока не подключён')
  })
  it('hides the decoration from assistive technology', () => {
    const html = loginHtml()
    expect(html).toContain('<span class="ck-login-rays" aria-hidden="true"></span>')
    expect(html).toContain('<div class="ck-login-rule" aria-hidden="true">')
    for (const svg of html.match(/<svg[^>]*>/g) ?? []) if (!svg.includes('ck-login-star')) expect(svg).toContain('aria-hidden="true"')
  })
  it('keeps the Tab order: name, password, «Войти», theme switch', () => {
    for (const html of [loginHtml(), loginHtml({ expired: true, state: failed('Неверное имя пользователя или пароль.') }), loginHtml({ state: { kind: 'pending' } })]) {
      const stops = [...html.matchAll(/<(input|button|a|select|textarea)\b[^>]*>/g)].map((match) => match[0])
      expect(stops).toHaveLength(4)
      expect(stops[0]).toContain('id="login-username"')
      expect(stops[1]).toContain('id="login-password"')
      expect(stops[2]).toContain('data-auth-submit="true"')
      expect(stops[3]).toContain('class="ck-theme-toggle"')
      // Nothing reorders the stops, and nothing is switched off: the button stays reachable during the request.
      expect(html).not.toContain('tabindex=')
      expect(html).not.toMatch(/\sdisabled=""/)
    }
  })
  it('puts the ended-session notice over the form and the theme switch after the note', () => {
    const html = loginHtml({ expired: true })
    expect(html).toContain('<section class="ck-auth" aria-labelledby="page-heading"><p class="ck-auth-notice" data-auth-expired="true">Сеанс завершён. Войдите снова.</p><form')
    expect(html).toMatch(/<p class="ck-login-note">[^<]*<\/p><div class="ck-login-footer"><button type="button" class="ck-theme-toggle" data-theme-current="dark">/)
  })
  it('mounts with empty fields and no message', () => {
    const html = renderToStaticMarkup(<LoginPage expired />)
    expect(tag(html, 'login-username')).not.toBe('')
    expect(tag(html, 'login-password')).not.toMatch(/value="[^"]/)
    expect(html).toContain(sessionExpiredText)
    expect(html).not.toContain('data-auth-error')
  })
})

describe('account page (Node server markup, not browser behavior)', () => {
  it('shows who is signed in as text and offers the sign-out', () => {
    const html = accountHtml({ username: '<b>synthetic</b>' })
    expect(html).toContain('<p class="ck-auth-username" data-auth-username="true">&lt;b&gt;synthetic&lt;/b&gt;</p>')
    expect(html).toContain('<button type="button" class="ck-auth-secondary" data-auth-logout="true" aria-describedby="logout-message">Выйти</button>')
  })
  it('labels the three password fields for a password manager', () => {
    const html = accountHtml()
    expect(html).toContain('<label for="account-current_password">Текущий пароль</label>')
    expect(html).toContain('<label for="account-new_password">Новый пароль</label>')
    expect(html).toContain('<label for="account-repeat">Новый пароль ещё раз</label>')
    expect(tag(html, 'account-current_password')).toContain('autocomplete="current-password"')
    expect(tag(html, 'account-new_password')).toContain('autocomplete="new-password"')
    expect(tag(html, 'account-new_password')).toContain('aria-describedby="account-password-rules"')
    expect(tag(html, 'account-repeat')).toContain('autocomplete="new-password"')
    for (const id of ['account-current_password', 'account-new_password', 'account-repeat']) expect(tag(html, id)).toContain('type="password"')
    const owner = (html.match(/<input\b[^>]*\bname="username"[^>]*>/)?.[0] ?? '').toLowerCase()
    for (const part of ['type="text"', 'autocomplete="username"', 'readonly=""', 'hidden=""', 'value="synthetic-reader"']) expect(owner).toContain(part)
    expect(html.match(/<form\b/g)).toHaveLength(1)
    expect(formTag(html)).toContain(' class="ck-auth-panel"')
    expect(formTag(html)).toContain(' method="post"')
    expect(html).toContain('<button type="submit" data-auth-submit="true" aria-describedby="password-message">Сменить пароль</button>')
  })
  it('lists the four rules of a new password before any attempt', () => {
    const html = accountHtml()
    const rules = html.split('<ul id="account-password-rules" class="ck-auth-rules">')[1].split('</ul>')[0]
    expect(rules.match(/<li>/g)).toHaveLength(4)
    expect(rules).toContain('не короче 8 символов')
  })
  it('shows a refused new password once with its causes and without the server\'s phrases', () => {
    const refusal = passwordRefusal({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['new_password'], passwordIssues: ['too_short', 'entirely_numeric'] })
    const html = accountHtml({ password: failed(refusal.message, refusal.fields, refusal.details) })
    expect(html.match(/data-auth-error/g)).toHaveLength(1)
    expect(html).toContain('<div class="ck-auth-error" data-auth-error="true"><p>Новый пароль не подходит. Пароль:</p><ul><li>не короче 8 символов</li><li>не должен состоять только из цифр</li></ul></div>')
    expect(tag(html, 'account-new_password')).toContain('aria-invalid="true"')
    expect(tag(html, 'account-current_password')).not.toContain('aria-invalid')
    expect(html).not.toContain('Пароль слишком короткий')
    expect(html).not.toContain('Некорректные параметры запроса')
  })
  it('marks a wrong current password and a mismatched repeat at their fields', () => {
    expect(tag(accountHtml({ password: failed('Текущий пароль неверный.', ['current_password']) }), 'account-current_password')).toContain('aria-invalid="true"')
    expect(tag(accountHtml({ password: failed('Новый пароль и его повтор не совпадают.', ['repeat']) }), 'account-repeat')).toContain('aria-invalid="true"')
  })
  it('reports a changed password once and keeps both buttons focusable during their requests', () => {
    const done = accountHtml({ password: { kind: 'done', message: passwordChangedText } })
    expect(count(done, passwordChangedText)).toBe(1)
    expect(done).toContain('data-auth-done="true"')
    const pending = accountHtml({ password: { kind: 'pending' }, signOut: { kind: 'pending' } })
    expect(pending).toContain('aria-disabled="true" aria-describedby="password-message">Сохраняем…</button>')
    expect(pending).toContain('aria-disabled="true" aria-describedby="logout-message">Выходим…</button>')
    expect(pending).not.toMatch(/<button[^>]*\sdisabled=""/)
  })
  it('keeps the results of the two actions apart', () => {
    const html = accountHtml({ signOut: failed('Ответ сервера не получен. Выход мог выполниться: обновите страницу и проверьте.') })
    expect(html).toMatch(/<div id="logout-message"[^>]*><div class="ck-auth-error"/)
    expect(html).toContain('<div id="password-message" class="ck-auth-message" aria-live="polite"></div>')
  })
})
