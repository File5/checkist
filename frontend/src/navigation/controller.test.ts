import { describe, expect, it, vi } from 'vitest'
import { createNavigation } from './controller'

function memoryHistory(initial = '/catalog') {
  const entries: { href: string; state: unknown }[] = [{ href: new URL(initial, 'http://localhost').href, state: null }]
  let position = 0
  const popListeners = new Set<() => void>()
  const environment = {
    getHref: () => entries[position].href,
    getState: () => entries[position].state,
    pushState: vi.fn((state: unknown, href: string) => {
      entries.splice(position + 1)
      entries.push({ href: new URL(href, environment.getHref()).href, state })
      position++
    }),
    replaceState: vi.fn((state: unknown, href: string) => {
      entries[position] = { href: new URL(href, environment.getHref()).href, state }
    }),
    listenPopState: (listener: () => void) => {
      popListeners.add(listener)
      return () => { popListeners.delete(listener) }
    },
  }
  return {
    environment, entries, popListeners,
    go(delta: number) {
      position += delta
      popListeners.forEach((listener) => listener())
    },
  }
}

describe('navigation without a browser', () => {
  it.each([
    ['/recognition/jobs/31', '/receipts/71'],
    ['/receipts/71', '/recognition/jobs/31'],
    ['/receipts/71', '/catalog/products/61'],
  ])('retains the source detail for %s → %s across query, reload and Back', (source, destination) => {
    const history = memoryHistory(source)
    const navigation = createNavigation(history.environment)
    const unsubscribe = navigation.subscribe(() => {})
    navigation.navigate(destination)
    expect(navigation.getSnapshot().returnTo).toBe(source)
    if (destination.startsWith('/catalog/')) navigation.navigate(`${destination}?currency=EUR&page=2`)
    expect(createNavigation(history.environment).getSnapshot().returnTo).toBe(source)
    history.go(-1)
    history.go(1)
    expect(navigation.getSnapshot().returnTo).toBe(source)
    navigation.navigate(source)
    expect(navigation.getSnapshot().href).toBe(source)
    unsubscribe()
  })
  it.each([
    ['/receipts?store=51&page=2', '/receipts/71', '/receipts?store=51&page=2'],
    ['/recognition/jobs?status=failed&page=3', '/recognition/jobs/31', '/recognition/jobs?status=failed&page=3'],
    ['/catalog/merges?status=confirmed&page=2', '/catalog/merges/3', '/catalog/merges?status=confirmed&page=2'],
  ])('retains the compatible list context from %s and restores it on Back', (list, detail, expected) => {
    const history = memoryHistory(list)
    const navigation = createNavigation(history.environment)
    const unsubscribe = navigation.subscribe(() => {})
    navigation.navigate(detail)
    expect(navigation.getSnapshot().returnTo).toBe(expected)
    expect(createNavigation(history.environment).getSnapshot().returnTo).toBe(expected)
    history.go(-1)
    expect(navigation.getSnapshot().returnTo).toBeUndefined()
    expect(navigation.getSnapshot().href).toBe(list)
    history.go(1)
    expect(navigation.getSnapshot().returnTo).toBe(expected)
    navigation.navigate('/catalog')
    expect(navigation.getSnapshot().returnTo).toBeUndefined()
    unsubscribe()
  })
  it.each([
    ['/receipts/71', '/recognition/jobs'], ['/recognition/jobs/31', '/receipts'],
    ['/receipts/71', '/receipts?page=0'], ['/recognition/jobs/31', 'https://evil.test/recognition/jobs'],
  ])('rejects inappropriate persisted context %s ← %s', (detail, context) => {
    const history = memoryHistory(detail)
    history.entries[0].state = { checkistReturnTo: context }
    expect(createNavigation(history.environment).getSnapshot().returnTo).toBeUndefined()
  })
  it('initializes from a direct URL and exposes a stable snapshot', () => {
    const history = memoryHistory('/catalog/products/2?store=3&page=2')
    const navigation = createNavigation(history.environment)
    expect(navigation.getSnapshot()).toEqual({ href: '/catalog/products/2?store=3&page=2', route: { kind: 'product', productId: 2, query: { store: 3, page: 2 } } })
    expect(navigation.getSnapshot()).toBe(navigation.getSnapshot())
  })

  it('publishes push/replace immediately without needing popstate', () => {
    const history = memoryHistory()
    const navigation = createNavigation(history.environment)
    const changed = vi.fn()
    const unsubscribe = navigation.subscribe(changed)
    navigation.navigate({ kind: 'category', categoryId: 2, query: { q: 'молоко', page: 3 } })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(history.environment.pushState).toHaveBeenCalledTimes(1)
    navigation.navigate('/health', { replace: true })
    expect(history.environment.replaceState).toHaveBeenCalledTimes(1)
    expect(history.entries).toHaveLength(2)
    expect(navigation.getSnapshot().route).toEqual({ kind: 'health' })
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(history.popListeners.size).toBe(0)
  })

  it('restores filters, pages and return context with Back/Forward and reload', () => {
    const history = memoryHistory('/catalog/categories/4?q=молоко&generic=8&page=3')
    const navigation = createNavigation(history.environment)
    const unsubscribe = navigation.subscribe(() => {})
    navigation.navigate('/catalog/products/9')
    const returnTo = '/catalog/categories/4?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&generic=8&page=3'
    expect(navigation.getSnapshot().returnTo).toBe(returnTo)
    navigation.navigate('/catalog/products/9?currency=EUR&page=2')
    expect(navigation.getSnapshot().returnTo).toBe(returnTo)
    expect(createNavigation(history.environment).getSnapshot().returnTo).toBe(returnTo)
    history.go(-2)
    expect(navigation.getSnapshot().route).toEqual({ kind: 'category', categoryId: 4, query: { q: 'молоко', generic: 8, page: 3 } })
    expect(navigation.getSnapshot().returnTo).toBeUndefined()
    history.go(2)
    expect(navigation.getSnapshot().route).toEqual({ kind: 'product', productId: 9, query: { currency: 'EUR', page: 2 } })
    expect(navigation.getSnapshot().returnTo).toBe(returnTo)
    unsubscribe()
  })

  it('ignores a repeated navigation and allows only same-origin HTTP URLs', () => {
    const history = memoryHistory()
    const navigation = createNavigation(history.environment)
    navigation.navigate('/catalog')
    expect(history.environment.pushState).not.toHaveBeenCalled()
    for (const target of ['https://evil.invalid/catalog', '//evil.invalid/catalog', 'javascript:alert(1)', 'mailto:user@example.com']) {
      expect(() => navigation.navigate(target)).toThrow(TypeError)
    }
    expect(history.entries).toHaveLength(1)
  })

  it('validates persisted return context instead of trusting history state', () => {
    const history = memoryHistory('/catalog/products/2')
    for (const checkistReturnTo of ['https://evil.invalid/catalog', '/health', '/catalog?page=0', '/catalog/products/2']) {
      history.entries[0].state = { checkistReturnTo }
      expect(createNavigation(history.environment).getSnapshot().returnTo).toBeUndefined()
    }
  })

  it('shares one listener and refreshes after an unsubscribed interval', () => {
    const history = memoryHistory()
    const navigation = createNavigation(history.environment)
    const first = navigation.subscribe(() => {})
    const second = navigation.subscribe(() => {})
    expect(history.popListeners.size).toBe(1)
    first()
    expect(history.popListeners.size).toBe(1)
    navigation.navigate('/health')
    second()
    expect(history.popListeners.size).toBe(0)
    history.go(-1)
    const third = navigation.subscribe(() => {})
    expect(navigation.getSnapshot().route.kind).toBe('catalog')
    expect(history.popListeners.size).toBe(1)
    third()
  })
})
