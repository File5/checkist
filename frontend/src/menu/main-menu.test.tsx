import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Route } from '../navigation'
import type { Session } from '../session'
import MainMenu from './MainMenu'

const loading: Session = { kind: 'loading' }
const guest: Session = { kind: 'guest', expired: false }
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, household: null, permissions: { moderate_catalog: false } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, household: null, permissions: { moderate_catalog: true } }
const catalog: Route = { kind: 'catalog', query: { page: 1 } }
const health: Route = { kind: 'health' }

const raw = (session: Session, route: Route) => renderToStaticMarkup(<MainMenu session={session} route={route} menuRef={{ current: null }} />)
/** The pictures (components/Icon) are checked once below; the other expectations read the words. */
const noIcons = (html: string) => html.replace(/<svg\b.*?<\/svg>/g, '')
const render = (session: Session, route: Route) => noIcons(raw(session, route))
const links = (html: string) => [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((match) => match[1])
const more = (html: string) => html.match(/<a class="main-more-toggle"[^>]*>Ещё<\/a>/g) ?? []

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
    ['thirteen items in local_single', local, ['Доходы', 'Платежи', 'Цели', 'Разбор месяца', 'Каталог', 'Магазины', 'Правила выписок', 'Обработка чеков', 'Выгрузка', 'Состояние сервисов']],
    ['fifteen items in accounts', reader, ['Доходы', 'Платежи', 'Цели', 'Разбор месяца', 'Каталог', 'Магазины', 'Правила выписок', 'Обработка чеков', 'Выгрузка', 'Семья', 'synthetic-reader', 'Состояние сервисов']],
  ])('keeps the links after the third one behind «Ещё» with %s', (_name, session, more) => {
    const html = render(session, { kind: 'not-found', path: '/missing' })
    // The same nav: «Главная · Траты · ＋ · Статистика · Ещё»; the sections are its direct children, with no new attributes.
    expect(html).toMatch(/^<nav class="main-navigation" aria-label="Основная навигация"><a href="\/">Главная<\/a><a href="\/receipts">Траты<\/a><div class="main-add">.*<\/div><a href="\/stats">Статистика<\/a><div class="main-more">/)
    expect(links(html)).toEqual(['Главная', 'Траты', 'Статистика', 'Ещё', ...more])
    // «Ещё» of the phone's bar is a link to its screen (/more, 2026-10-13); «＋» a closed sheet (a dialog, components/Sheet).
    expect(html).toContain('<a class="main-more-toggle" href="/more">Ещё</a>')
    expect(html).toContain('<button type="button" class="main-add-toggle" aria-haspopup="dialog" aria-expanded="false" aria-label="Добавить: снять чек, выбрать из галереи, внести трату или доход, загрузить выписку">')
    const list = html.split('<div class="main-more-list">')[1]
    expect(links(list)).toEqual(more)
    // The theme and the pictures of the spends live on the screen «Ещё» (features/more), not in the menu.
    expect(html).not.toContain('main-more-theme')
    // The sections for the header row of a wide screen: «Деньги» — links; «Данные» and «Настройки» — a word with ▾.
    expect(list).toContain('<div class="main-more-tiles" role="group" aria-label="Деньги"><a href="/incomes">')
    expect(html).toContain('<div class="main-group"><button type="button" class="main-group-toggle" aria-expanded="false" aria-controls="main-group-data">Данные</button><div class="main-group-list" id="main-group-data" role="group" aria-label="Данные"><a href="/catalog">')
    expect(html).not.toMatch(/role="(dialog|menu)"|aria-modal/)
    expect(html.match(/aria-haspopup/g)).toHaveLength(1)
    expect(html).not.toMatch(/<img/)
  })

  it('draws a picture over each word of the bar and before each row of «Ещё», hidden from the screen reader', () => {
    const html = raw(reader, catalog)
    const pictures = html.match(/<svg\b[^>]*>/g) ?? []
    // Twelve links behind «Ещё», three of the bar, «Ещё» itself, «＋» (26 px) and ▾ of «Данные» and «Настройки».
    expect(pictures.filter((tag) => tag.includes('class="ck-icon"'))).toHaveLength(3 + 12 + 1 + 1 + 2)
    for (const tag of pictures) expect(tag).toContain('aria-hidden="true"')
    expect(html).toMatch(/<a href="\/"><svg class="ck-icon" viewBox="0 0 24 24" width="22" height="22"[^>]*>.*?<\/svg>Главная<\/a>/)
    expect(html).toMatch(/<button type="button" class="main-add-toggle"[^>]*><svg class="ck-icon" viewBox="0 0 24 24" width="26" height="26"/)
  })

  it('offers the actions: «Снять чек» and «Из галереи» with their fields outside of the sheet, and «Трата или доход»', () => {
    const html = render(reader, catalog)
    const add = html.slice(html.indexOf('<div class="main-add">'), html.indexOf('<a href="/stats">'))
    // Closed: the button and the two fields only. The open sheet is drawn by Sheet (components/sheet-markup.test.tsx).
    expect(add).not.toContain('main-add-list')
    const source = readFileSync(new URL('./MainMenu.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<Sheet open={open} onClose={close} title="Добавить" id={ADD_SHEET_ID}>')
    // Big rows: a picture, the action and a line about it; «Снять чек» is the main one.
    expect(source).toContain(`<button type="button" className="main-add-action main-add-primary" onClick={choose(shot.open)}>{body('camera', 'Снять чек', `)
    expect(source).toContain(`<button type="button" className="main-add-action" onClick={choose(gallery.open)}>{body('image', 'Из галереи', `)
    expect(source).toContain(`<Link className="main-add-action" to="/receipts/new" onClick={close}>{body('pencil', 'Трата или доход', `)
    // The fields stay mounted when the sheet closes: iOS opens the camera or the picker only from the press itself.
    // The gallery has no capture, so iOS offers the photo library and Files; a PDF bill is accepted too.
    expect(source.indexOf('</Sheet>')).toBeLessThan(source.indexOf('{shot.field}'))
    expect(add).toMatch(/<\/button><input class="ck-quick-shot-input" type="file" accept="image\/\*" capture="environment" tabindex="-1" aria-hidden="true"\/>/)
    expect(add).toMatch(/<input class="ck-quick-shot-input" type="file" accept="image\/\*,\.heic,\.heif,application\/pdf" tabindex="-1" aria-hidden="true"\/><\/div>$/)
  })

  it('keeps the account link as it was in the header', () => {
    expect(render(reader, { kind: 'account' })).toContain('<a class="account-link" aria-label="Аккаунт: synthetic-reader" aria-current="page" href="/account">synthetic-reader</a>')
    expect(render(local, { kind: 'account' })).not.toContain('account-link')
  })

  it.each<[string, Route, string]>([
    ['the catalog', catalog, 'Каталог'],
    ['«Обработка чеков»', { kind: 'jobs', query: { page: 1 } }, 'Обработка чеков'],
    ['the health page', health, 'Состояние сервисов'],
    ['the account', { kind: 'account' }, 'synthetic-reader'],
  ])('marks «Ещё» as current, and not by colour alone, while %s is open', (_name, route, label) => {
    const html = render(reader, route)
    expect(more(html)).toEqual([`<a class="main-more-toggle" aria-label="Ещё, текущий раздел: ${label}" data-current="" href="/more">Ещё</a>`])
    // The link of the section keeps aria-current; «Ещё» does not take it: the effect of the header row looks for the link.
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(new RegExp(`<a [^>]*aria-current="page"[^>]*>${label}</a>`))
  })

  it('leaves «Ещё» unmarked while the current section is in the bar or nowhere in the menu', () => {
    for (const route of [{ kind: 'receipts', query: { page: 1 } }, { kind: 'upload' }, { kind: 'spending', query: {} }, { kind: 'not-found', path: '/missing' }] as Route[]) {
      const html = render(reader, route)
      expect(html, route.kind).not.toContain('data-current')
      expect(more(html), route.kind).toEqual(['<a class="main-more-toggle" href="/more">Ещё</a>'])
    }
  })

  it('marks «Ещё» as the current page on its own screen', () => {
    expect(more(render(reader, { kind: 'more' }))).toEqual(['<a class="main-more-toggle" aria-current="page" href="/more">Ещё</a>'])
  })
})
