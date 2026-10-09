import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Route } from '../navigation'
import type { Session } from '../session'
import MainMenu from './MainMenu'

const loading: Session = { kind: 'loading' }
const guest: Session = { kind: 'guest', expired: false }
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, permissions: { moderate_catalog: false } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }
const catalog: Route = { kind: 'catalog', query: { page: 1 } }
const health: Route = { kind: 'health' }

const render = (session: Session, route: Route) => renderToStaticMarkup(<MainMenu session={session} route={route} menuRef={{ current: null }} />)
const links = (html: string) => [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((match) => match[1])
const button = (html: string) => html.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? []

describe('markup of the main menu (SSR only: the bar, touches and keys are checked by a person)', () => {
  it.each<[string, Session, string[]]>([
    ['one item while «Я» is being read', loading, ['Состояние сервисов']],
    ['two items for a guest', guest, ['Состояние сервисов', 'Войти']],
  ])('has no «Ещё» with %s', (_name, session, menu) => {
    const html = render(session, health)
    expect(links(html)).toEqual(menu)
    expect(html).not.toContain('<button')
    expect(html).not.toContain('main-more')
    expect(html).toMatch(/^<nav class="main-navigation" aria-label="Основная навигация"><a /)
  })

  it.each<[string, Session, string[]]>([
    ['five items in local_single', local, ['Обработка', 'Состояние сервисов']],
    ['six items in accounts', reader, ['Обработка', 'Состояние сервисов', 'synthetic-reader']],
  ])('keeps the links after the third one behind «Ещё» with %s', (_name, session, more) => {
    const html = render(session, catalog)
    // The same nav: the three sections are its direct children, as before, with no new attributes.
    expect(html).toMatch(/^<nav class="main-navigation" aria-label="Основная навигация"><a aria-current="page" href="\/catalog">Каталог<\/a><a href="\/receipts">Чеки<\/a><a href="\/stats">Статистика<\/a><div class="main-more">/)
    expect(links(html)).toEqual(['Каталог', 'Чеки', 'Статистика', ...more])
    // A closed button that names the list it opens; the list is not a dialog.
    expect(button(html)).toEqual(['<button type="button" class="main-more-toggle" aria-expanded="false" aria-controls="main-more-list">Ещё</button>'])
    const list = html.split('<div class="main-more-list" id="main-more-list">')[1].split('</div>')[0]
    expect(links(list)).toEqual(more)
    expect(html.match(/id="main-more-list"/g)).toHaveLength(1)
    expect(html).not.toMatch(/role="(dialog|menu)"|aria-modal|aria-haspopup/)
    expect(html).not.toMatch(/<svg|<img/)
  })

  it('keeps the account link as it was in the header', () => {
    expect(render(reader, { kind: 'account' })).toContain('<a class="account-link" aria-label="Аккаунт: synthetic-reader" aria-current="page" href="/account">synthetic-reader</a>')
    expect(render(local, { kind: 'account' })).not.toContain('account-link')
  })

  it.each<[string, Route, string]>([
    ['«Обработка»', { kind: 'jobs', query: { page: 1 } }, 'Обработка'],
    ['the health page', health, 'Состояние сервисов'],
    ['the account', { kind: 'account' }, 'synthetic-reader'],
  ])('marks «Ещё» as current, and not by colour alone, while %s is open', (_name, route, label) => {
    const html = render(reader, route)
    expect(button(html)).toEqual([`<button type="button" class="main-more-toggle" aria-expanded="false" aria-controls="main-more-list" aria-label="Ещё, текущий раздел: ${label}" data-current="">Ещё</button>`])
    // The link keeps aria-current; the button does not take it: the effect of the header row looks for the link.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`))
  })

  it('leaves «Ещё» unmarked while the current section is in the bar or nowhere in the menu', () => {
    for (const route of [catalog, { kind: 'upload' }, { kind: 'spending', query: {} }, { kind: 'not-found', path: '/missing' }] as Route[]) {
      const html = render(reader, route)
      expect(html, route.kind).not.toContain('data-current')
      expect(button(html)[0], route.kind).not.toContain('aria-label')
    }
  })
})
