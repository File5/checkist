import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoginPage } from './index'
import { LoginPage as DirectLoginPage, LoginView } from './LoginPage'
import { initialLoginState } from './login-state'
import type { LoginFailure, LoginState } from './login-state'

const noop = () => {}
const view = (state: LoginState = initialLoginState) => renderToStaticMarkup(<LoginView state={state} onSubmit={noop} onEdit={noop} />)
const failed = (outcome: LoginFailure) => view({ kind: 'failed', outcome })
const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? ''
const loginInput = (html: string) => tag(html, /<input[^>]*id="ck-login-username"[^>]*>/)
const passwordInput = (html: string) => tag(html, /<input[^>]*id="ck-login-password"[^>]*>/)
const submitButton = (html: string) => tag(html, /<button[^>]*class="ck-login-submit"[^>]*>.*?<\/button>/)
const status = (html: string) => tag(html, /<div class="ck-login-status" role="status">.*?<\/div><\/form>/)
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '')

describe('login screen (SSR in Node, not browser behavior)', () => {
  it('renders without a browser', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
    expect(renderToStaticMarkup(<LoginPage />)).toBe(view())
    expect(DirectLoginPage).toBe(LoginPage)
  })

  it('needs no props and draws its own main and the only heading', () => {
    // React puts an image preload hint in front of the server markup; the screen itself is one <main>.
    const html = renderToStaticMarkup(<LoginPage />).replace(/^<link rel="preload" as="image"[^>]*\/>/, '')
    expect(html.startsWith('<main class="ck-login">')).toBe(true)
    expect(html.endsWith('</main>')).toBe(true)
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('<h1 class="ck-login-title" id="page-heading" tabindex="-1">Чекист</h1>')
    expect(html).not.toMatch(/<header\b|<nav\b|<footer\b/)
  })

  it('shows the logo in two sizes with its text alternative', () => {
    const image = tag(view(), /<img[^>]*>/)
    expect(image).toContain('alt="Чекист — продуктовая разведка"')
    expect(image).toMatch(/src="[^"]*logo-640[^"]*\.webp"/)
    expect(image).toMatch(/srcSet="[^"]*logo-640[^"]*\.webp 640w, [^"]*logo-1280[^"]*\.webp 1280w"/)
    expect(image).toContain('sizes="(min-width: 720px) min(50vw, 560px), 33vh"')
    expect(image).toContain('width="640"')
    expect(image).toContain('height="640"')
    expect(view().match(/<img\b/g)).toHaveLength(1)
  })

  it('words the screen: title, motto, invitation and the note under the form', () => {
    const html = view()
    expect(html).toContain('<p class="ck-login-subtitle">Продуктовая разведка</p>')
    expect(html).toContain('<p class="ck-login-invite">Предъявите пропуск</p>')
    expect(html).toContain('<p class="ck-login-note">Пропуска выдаёт администратор</p>')
    expect(html.indexOf('ck-login-note')).toBeGreaterThan(html.indexOf('</form>'))
  })

  it('hides the decoration from assistive technology', () => {
    const html = view()
    expect(html).toContain('<span class="ck-login-rays" aria-hidden="true"></span>')
    expect(html).toContain('<div class="ck-login-rule" aria-hidden="true">')
    for (const svg of html.match(/<svg[^>]*>/g) ?? []) {
      if (!svg.includes('ck-login-star')) expect(svg).toContain('aria-hidden="true"')
    }
  })

  it('is a real post form with labelled fields', () => {
    const html = view()
    const form = tag(html, /<form[^>]*>/)
    expect(form).toContain('method="post"')
    expect(form).toContain('noValidate=""')
    expect(form).toContain('aria-label="Вход"')
    expect(form).toContain('aria-busy="false"')
    expect(form).not.toContain('action=')
    expect(html).toContain('<label class="ck-login-label" for="ck-login-username">Логин</label>')
    expect(html).toContain('<label class="ck-login-label" for="ck-login-password">Пароль</label>')
    expect(loginInput(html)).toContain('type="text"')
    expect(loginInput(html)).toContain('name="username"')
    expect(loginInput(html)).toContain('autoComplete="username"')
    expect(passwordInput(html)).toContain('type="password"')
    expect(passwordInput(html)).toContain('name="password"')
    expect(passwordInput(html)).toContain('autoComplete="current-password"')
    expect(html.match(/<input\b/g)).toHaveLength(2)
    // Uncontrolled: the markup never carries a typed value.
    expect(html).not.toMatch(/<input[^>]*\svalue=/)
    expect(submitButton(html)).toBe('<button class="ck-login-submit" type="submit">Войти</button>')
  })

  it('keeps the Tab order: login, password, «Войти», catalog link, theme switch', () => {
    const html = view()
    const stops = [...html.matchAll(/<(input|button|a)\b[^>]*>/g)].map((match) => match[0])
    expect(stops).toHaveLength(5)
    expect(stops[0]).toContain('id="ck-login-username"')
    expect(stops[1]).toContain('id="ck-login-password"')
    expect(stops[2]).toContain('class="ck-login-submit"')
    expect(stops[3]).toBe('<a class="ck-login-link" href="/catalog">')
    expect(stops[4]).toContain('class="ck-theme-toggle"')
    // Nothing reorders the stops: the heading is focusable by script only.
    expect(html.match(/tabindex="/g)).toHaveLength(1)
    expect(html).toContain('<a class="ck-login-link" href="/catalog">Каталог продуктов</a>')
  })

  it('starts without errors or messages, with an empty status region', () => {
    const html = view()
    expect(html).not.toContain('aria-invalid')
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('ck-login-field-error')
    expect(status(html)).toBe('<div class="ck-login-status" role="status"></div></form>')
    expect(html.match(/role="status"/g)).toHaveLength(1)
  })

  it('marks both empty fields and ties each to its error text', () => {
    const html = view({ kind: 'empty', fields: ['login', 'password'] })
    expect(loginInput(html)).toContain('aria-invalid="true"')
    expect(loginInput(html)).toContain('aria-describedby="ck-login-username-error"')
    expect(passwordInput(html)).toContain('aria-invalid="true"')
    expect(passwordInput(html)).toContain('aria-describedby="ck-login-password-error"')
    expect(html).toMatch(/<p class="ck-login-field-error" id="ck-login-username-error"><svg class="ck-login-mark"[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Введите логин<\/p>/)
    expect(html).toMatch(/<p class="ck-login-field-error" id="ck-login-password-error"><svg class="ck-login-mark"[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Введите пароль<\/p>/)
    expect(status(html)).toBe('<div class="ck-login-status" role="status"></div></form>')
    expect(submitButton(html)).not.toContain('aria-disabled')
  })

  it('marks only the empty field', () => {
    const html = view({ kind: 'empty', fields: ['password'] })
    expect(loginInput(html)).not.toContain('aria-invalid')
    expect(loginInput(html)).not.toContain('aria-describedby')
    expect(html).not.toContain('Введите логин')
    expect(passwordInput(html)).toContain('aria-invalid="true"')
    expect(html).toContain('Введите пароль')
  })

  it('locks the button while submitting and keeps it focusable', () => {
    const html = view({ kind: 'submitting' })
    expect(submitButton(html)).toBe('<button class="ck-login-submit" type="submit" aria-disabled="true">Входим…</button>')
    expect(submitButton(html)).not.toContain('disabled=""')
    expect(tag(html, /<form[^>]*>/)).toContain('aria-busy="true"')
    expect(status(html)).toBe('<div class="ck-login-status" role="status"></div></form>')
  })

  it('explains that sign-in is not connected and leads to the catalog', () => {
    const html = failed('unavailable')
    expect(status(html)).toContain('<div class="ck-login-message ck-login-message-info">')
    expect(text(status(html))).toBe('Вход пока не подключён: пропускной режим не введён. Пройти в каталог')
    expect(status(html)).toContain('<a class="ck-login-link" href="/catalog">Пройти в каталог</a>')
    expect(submitButton(html)).toBe('<button class="ck-login-submit" type="submit">Войти</button>')
    // The link of the message comes right after the button, before the permanent one.
    const links = [...html.matchAll(/<a\b[^>]*>(.*?)<\/a>/g)].map((match) => match[1])
    expect(links).toEqual(['Пройти в каталог', 'Каталог продуктов'])
    expect(html.indexOf('Пройти в каталог')).toBeGreaterThan(html.indexOf('ck-login-submit'))
  })

  it.each([
    ['invalid', 'error', 'Неверный логин или пароль'],
    ['throttled', 'warning', 'Слишком много попыток. Повторите позже'],
    ['network', 'error', 'Не удалось связаться с сервером. Повторите попытку'],
  ] as const)('reports %s in the status region with a mark, not by colour alone', (outcome, tone, message) => {
    const html = failed(outcome)
    expect(status(html)).toContain(`<div class="ck-login-message ck-login-message-${tone}">`)
    expect(status(html)).toMatch(/<svg class="ck-login-mark"[^>]*aria-hidden="true"/)
    expect(text(status(html))).toBe(message)
    expect(status(html)).not.toContain('<a ')
    expect(submitButton(html)).toBe('<button class="ck-login-submit" type="submit">Войти</button>')
    expect(html).not.toContain('aria-invalid')
  })

  it('keeps the form locked after a successful sign-in', () => {
    const html = view({ kind: 'entered' })
    expect(status(html)).toContain('<div class="ck-login-message ck-login-message-success">')
    expect(text(status(html))).toBe('Вход выполнен. Открываем каталог…')
    expect(submitButton(html)).toBe('<button class="ck-login-submit" type="submit" aria-disabled="true">Войти</button>')
  })

  it('uses only classes of the screen and of the theme switch', () => {
    for (const state of [initialLoginState, { kind: 'empty', fields: ['login', 'password'] }, { kind: 'submitting' }, { kind: 'failed', outcome: 'unavailable' }, { kind: 'entered' }] as LoginState[]) {
      const classes = [...view(state).matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1].split(' '))
      expect(classes.filter((name) => name !== 'ck-login' && !name.startsWith('ck-login-') && !name.startsWith('ck-theme-'))).toEqual([])
    }
  })
})
