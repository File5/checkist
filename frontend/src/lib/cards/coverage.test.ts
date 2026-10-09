import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, source), 'utf8')

/**
 * Screens that still show their table on a phone, with the reason. One file — one line: the subtask that gives
 * a table its cards removes its own line, and parallel removals of different lines merge without a conflict.
 */
const exceptions: Record<string, string> = {
  'features/product/PriceHistory.tsx': 'Т1: история цен — карточки делает подзадача товара',
  'features/receipts/ReceiptContent.tsx': 'Т2: строки чека — карточки делает подзадача чеков',
  'features/stats/receipts-compare.tsx': 'Т4: слагаемые и совпавшие товары — карточки делает подзадача статистики',
  'lib/charts/LineChart.tsx': 'Т6: «Таблица значений» графика — карточки делает подзадача графиков',
  'lib/charts/PieChart.tsx': 'постоянно: легенда круговой диаграммы остаётся таблицей (три колонки, связь с секторами)',
}

/** Working components: tests and the static snapshots in preview/ are not a part of the client. */
const components = (readdirSync(source, { recursive: true }) as string[])
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => path.endsWith('.tsx') && !path.includes('.test.') && !/(^|[/-])preview\//.test(path))
  .sort()

const tables = components.filter((path) => read(path).includes('<table'))
const usesNarrow = (path: string) => /\buseNarrow\(/.test(read(path))

describe('every table has a phone view (text of the sources, not rendering)', () => {
  it('finds the tables of the client', () => {
    expect(components).toContain('lib/cards/RecordCards.tsx')
    expect(tables.length).toBeGreaterThan(0)
  })

  it('chooses the view with useNarrow in every component with a table, or names the reason why not', () => {
    expect(tables.filter((path) => !usesNarrow(path) && !(path in exceptions))).toEqual([])
  })

  it('keeps no exception for a component that already chooses the view: remove its line', () => {
    expect(Object.keys(exceptions).filter((path) => components.includes(path) && usesNarrow(path))).toEqual([])
  })

  it('keeps no exception for a component without a table', () => {
    expect(Object.keys(exceptions).filter((path) => !tables.includes(path))).toEqual([])
    for (const reason of Object.values(exceptions)) expect(reason.trim().length).toBeGreaterThan(10)
  })
})
