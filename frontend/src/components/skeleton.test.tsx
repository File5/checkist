import { readFileSync } from 'node:fs'
import { Suspense } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScreenLoadError, StoresPage } from '../screens'
import RequestState from './RequestState'
import ScreenBoundary, { ScreenFallback, ScreenSkeleton } from './ScreenBoundary'

const count = (html: string, part: string) => html.split(part).length - 1
/** The words a person reads: everything outside the tags. */
const words = (html: string) => html.replace(/<[^>]+>/g, '')

describe('loading skeletons (components/Skeleton.tsx through RequestState, server markup)', () => {
  it('draws a card of a page: a title line, a big figure and three rows; the words only for a screen reader', () => {
    const html = renderToStaticMarkup(<RequestState kind="loading" message="Загружаем цели…" />)
    expect(html).toMatch(/^<div class="request-state request-state-loading" aria-live="polite" aria-busy="true"><p class="ck-skel-message">Загружаем цели…<\/p>/)
    expect(html).toContain('<div class="ck-skel ck-skel-page" data-skeleton="page" aria-hidden="true">')
    expect(count(html, 'class="ck-skel-figure ')).toBe(1)
    expect(count(html, 'class="ck-skel-row"')).toBe(3)
    expect(words(html)).toBe('Загружаем цели…')
  })

  it('keeps the old words when a screen names none', () => {
    expect(words(renderToStaticMarkup(<RequestState kind="loading" />))).toBe('Загружаем данные…')
  })

  it('draws «Главная» as its own cards on the page: the month with its figure and bar, two actions, the latest spends, the limits', () => {
    const html = renderToStaticMarkup(<RequestState kind="loading" message="Загружаем траты месяца…" shape="home" />)
    expect(html).toContain('class="request-state request-state-loading request-state-bare"')
    expect(html).toContain('data-skeleton="home"')
    expect(count(html, 'class="ck-skel-figure ck-skel-hero-figure')).toBe(1)
    expect(count(html, 'class="ck-skel-action"')).toBe(2)
    expect(count(html, 'class="ck-skel-row"')).toBe(4)
    expect(count(html, 'class="ck-skel-limit"')).toBe(3)
    expect(count(html, 'class="ck-skel-card')).toBe(3)
    expect(words(html)).toBe('Загружаем траты месяца…')
  })

  it('draws «Траты» as two days: a header line over a card of rows', () => {
    const html = renderToStaticMarkup(<RequestState kind="loading" message="Загружаем: список трат…" shape="spends" />)
    expect(html).toContain('class="request-state request-state-loading request-state-bare"')
    expect(html).toContain('data-skeleton="spends"')
    expect(count(html, 'class="ck-skel-day"')).toBe(2)
    expect(count(html, 'class="ck-skel-day-head"')).toBe(2)
    expect(count(html, 'class="ck-skel-row"')).toBe(5)
  })

  it('draws two small lines inside a card (compact), whatever the shape', () => {
    const html = renderToStaticMarkup(<RequestState kind="loading" compact shape="home" />)
    expect(html).toContain('class="request-state request-state-loading request-state-compact"')
    expect(html).toContain('<div class="ck-skel ck-skel-compact" data-skeleton="compact" aria-hidden="true">')
    expect(count(html, 'class="ck-skel-line')).toBe(2)
    expect(html).not.toContain('ck-skel-row')
  })

  it('leaves the empty and the failed states as they were', () => {
    expect(renderToStaticMarkup(<RequestState kind="empty" message="Пусто." />)).toBe('<div class="request-state request-state-empty" aria-live="polite" aria-busy="false"><p>Пусто.</p></div>')
  })
})

describe('the fallback of a screen whose script is on its way (components/ScreenBoundary.tsx)', () => {
  it('has the shape of the screen: «Главная», «Траты» with its search and filters, any other page', () => {
    const home = renderToStaticMarkup(<ScreenFallback kind="dashboard" />)
    expect(home).toContain('data-skeleton="home"')
    expect(words(home)).toBe('Открываем экран…')
    const spends = renderToStaticMarkup(<ScreenFallback kind="receipts" />)
    expect(spends.indexOf('data-skeleton="spends-top"')).toBeGreaterThan(-1)
    expect(spends.indexOf('data-skeleton="spends-top"')).toBeLessThan(spends.indexOf('data-skeleton="spends"'))
    expect(spends).toContain('aria-busy="true"')
    expect(renderToStaticMarkup(<ScreenFallback kind="goals" />)).toContain('data-skeleton="page"')
  })

  it('shows «Экран не загрузился» with «Повторить» for a script that did not come, and passes any other error on', () => {
    const boundary = new ScreenBoundary({ resetKey: '/goals', children: <p>Цели</p> })
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>Цели</p>')
    boundary.state = { resetKey: '/goals', ...ScreenBoundary.getDerivedStateFromError(new ScreenLoadError('GoalsPage', new TypeError('offline'))) }
    const html = renderToStaticMarkup(<>{boundary.render()}</>)
    expect(html).toContain('<strong>Экран не загрузился</strong>')
    expect(html).toContain('Проверьте соединение и обновите страницу.')
    expect(html).toContain('data-request-retry="true">Повторить</button>')
    const other = new Error('render failed')
    boundary.state = { resetKey: '/goals', ...ScreenBoundary.getDerivedStateFromError(other) }
    expect(() => boundary.render()).toThrow(other)
  })

  it('draws the same skeleton while the sign-in is checked, with its own words', () => {
    const html = renderToStaticMarkup(<ScreenSkeleton kind="dashboard" message="Проверяем вход…" />)
    expect(html).toContain('data-skeleton="home"')
    expect(words(html)).toBe('Проверяем вход…')
  })

  it('does not let the markup of a server hide the error of a loaded screen behind its fallback (tests of the shell)', async () => {
    await StoresPage.preload()
    const Broken = () => { throw new Error('broken screen') }
    expect(() => renderToStaticMarkup(<Suspense fallback={<ScreenFallback kind="stores" />}><Broken /></Suspense>))
      .toThrow('The screen of «stores» is loaded but did not render')
  })

  it('takes the failure off on another address', () => {
    const failed = { failed: new ScreenLoadError('GoalsPage', null), resetKey: '/goals' }
    expect(ScreenBoundary.getDerivedStateFromProps({ resetKey: '/goals', children: null }, failed)).toBeNull()
    expect(ScreenBoundary.getDerivedStateFromProps({ resetKey: '/receipts', children: null }, failed)).toEqual({ failed: undefined, resetKey: '/receipts' })
  })
})

describe('rules of the skeletons (text of Skeleton.css, not rendering)', () => {
  const css = readFileSync(new URL('./Skeleton.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const motion = '@media (prefers-reduced-motion: no-preference) {'

  it('hides the words visually only', () => {
    const message = /\.ck-skel-message \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(message).toContain('position: absolute; width: 1px; height: 1px;')
    expect(message).toContain('clip-path: inset(50%);')
  })

  it('paints the blocks by the skeleton token and sets no text size', () => {
    expect(css).toContain('background: var(--ck-skeleton);')
    expect(css).not.toMatch(/font-size/)
  })

  it('pulses only without reduced motion: static blocks otherwise', () => {
    expect(css.split(motion)).toHaveLength(2)
    expect(css.slice(0, css.indexOf(motion))).not.toMatch(/animation|transition|@keyframes/)
    expect(css.slice(css.indexOf(motion))).toContain('@keyframes ck-skel-pulse')
  })

  it('keeps the layout of «Главная»: one column of a phone, two from 960 px', () => {
    expect(css).toContain('.ck-skel-column { display: contents; }')
    expect(css).toContain('@media (min-width: 960px) {')
  })

  it('takes the skeleton colour and the network bar from tokens.css in both themes', () => {
    const tokens = readFileSync(new URL('../theme/tokens.css', import.meta.url), 'utf8')
    expect(tokens).toContain('--ck-skeleton: var(--ck-track);')
    expect(tokens).toContain('--ck-network-track: color-mix(in srgb, var(--ck-primary) 25%, transparent);')
    const layer = (name: string) => Number(new RegExp(`--ck-z-${name}: (\\d+);`).exec(tokens)?.[1])
    expect(layer('network-bar')).toBeGreaterThan(layer('sheet'))
    expect(layer('network-bar')).toBeLessThan(layer('skip-link'))
  })
})
