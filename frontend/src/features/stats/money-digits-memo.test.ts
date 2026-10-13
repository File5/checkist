import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, source), 'utf8')

/**
 * Components that keep texts of money between renders (`useMemo`). The choice «Суммы: Целые / С копейками»
 * (`lib/money-digits.ts`) re-renders the tree, but a kept text is rebuilt only when its dependencies change — so each
 * of these reads `useMoneyDigits()` and passes the mode to its builder. A new component of this kind adds its line.
 */
const memoised = [
  'features/stats/trends-dashboard.tsx',
  'features/stats/trends-blocks.tsx',
  'features/stats/receipts-trend.tsx',
  'features/stats/spending-results.tsx',
]

/** Builders of «Статистика» whose result holds formatted sums: called inside `useMemo` only with the mode. */
const builders = ['monthRows', 'limitRows', 'monthlyChart', 'categoryChart', 'partsChart', 'trendCharts', 'blockView']

/** Working sources: tests and the static snapshots in preview/ are not a part of the client. */
const sources = (readdirSync(source, { recursive: true }) as string[])
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => /\.tsx?$/.test(path) && !path.includes('.test.') && !/(^|[/-])preview\//.test(path))
  .sort()

/** `useMemo(…)` calls of a source, each with its dependency list: from the call to the `])` that ends its line. */
const memos = (text: string) => [...text.matchAll(/useMemo\([\s\S]*?\]\)(?=\s*\n)/g)].map((match) => match[0])
const formatsMoney = /\b(formatMoney|formatMoneyNumber|formatCents|formatCentsNumber|formatApproxMoney|formatMoneyWithBase|baseTwin|money)\(/
const callsBuilder = new RegExp(`\\b(${builders.join('|')})\\(`)

describe('sums kept in useMemo follow «Суммы» (text of the sources, not rendering)', () => {
  it('finds the sources of the client and every listed component', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(memoised.filter((path) => !sources.includes(path))).toEqual([])
  })

  it.each(memoised)('reads the mode with useMoneyDigits() in %s', (path) => {
    expect(read(path)).toMatch(/\buseMoneyDigits\(/)
    expect(read(path)).toContain("import { useMoneyDigits } from '../../lib/money-digits'")
  })

  it.each(memoised)('passes the mode to every kept builder of sums in %s and names it in the dependencies', (path) => {
    const kept = memos(read(path)).filter((memo) => callsBuilder.test(memo))
    expect(kept.length).toBeGreaterThan(0)
    for (const memo of kept) {
      // The mode is an argument of the builder…
      expect(memo, memo).toMatch(new RegExp(`\\b(${builders.join('|')})\\([^\\n]*\\bdigits\\)`))
      // …and a dependency: the last bracket of the call.
      expect(memo.slice(memo.lastIndexOf('[')), memo).toMatch(/\bdigits\b/)
    }
  })

  it('keeps no sum in a useMemo of any other source without the mode in its dependencies', () => {
    const stale = sources.flatMap((path) => memos(read(path))
      .filter((memo) => (formatsMoney.test(memo) || callsBuilder.test(memo)) && !/\bdigits\b/.test(memo.slice(memo.lastIndexOf('['))))
      .map((memo) => `${path}: ${memo.split('\n')[0]}`))
    expect(stale).toEqual([])
  })

  it('gives every builder the mode as its last parameter, the device choice by default', () => {
    const texts = ['features/stats/trends-state.ts', 'features/stats/receipts-series.ts', 'features/stats/spending-view.ts'].map(read).join('\n')
    for (const name of builders) {
      expect(texts, name).toMatch(new RegExp(`export function ${name}\\([^{]*\\bdigits: MoneyDigits = moneyDigits\\(\\)\\)`))
    }
  })
})
