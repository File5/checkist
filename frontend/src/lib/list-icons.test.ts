import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { categoryIcon, categoryIcons } from './category-icons'
import { listIconsLabel, listIconsStorageKey, parseListIcons, setListIcons } from './list-icons'

describe('pictures of the spend rows (2026-10-13)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setListIcons('category')
  })

  it('shows the category unless the device chose how the spend came in', () => {
    expect([parseListIcons('source'), parseListIcons('category'), parseListIcons(null), parseListIcons('карта')])
      .toEqual(['source', 'category', 'category', 'category'])
    expect([listIconsLabel('category'), listIconsLabel('source')]).toEqual(['Значки: категория', 'Значки: как внесена'])
  })

  it('keeps the choice under its key, and lives without storage', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
      addEventListener: () => {}, removeEventListener: () => {},
    })
    setListIcons('source')
    expect(saved.get(listIconsStorageKey)).toBe('source')
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } })
    expect(() => setListIcons('category')).not.toThrow()
  })

  it('draws an unknown or missing key of a category as the tag', () => {
    expect([categoryIcon('cart'), categoryIcon('home'), categoryIcon(null), categoryIcon(undefined), categoryIcon('rocket')])
      .toEqual(['cart', 'home', 'tag', 'tag', 'tag'])
  })

  it('offers exactly the keys of the server (catalog.CategoryIcon)', () => {
    const models = readFileSync(new URL('../../../backend/catalog/models.py', import.meta.url), 'utf8')
    const block = models.slice(models.indexOf('class CategoryIcon'), models.indexOf('class Category(models.Model)'))
    const server = [...block.matchAll(/^\s+[A-Z]+ = "([a-z]+)", "([^"]+)"$/gm)].map((match) => [match[1], match[2]])
    expect(new Set(server.map(([key]) => key))).toEqual(new Set(categoryIcons.map(([key]) => key)))
    expect(Object.fromEntries(server)).toEqual(Object.fromEntries(categoryIcons))
  })
})
