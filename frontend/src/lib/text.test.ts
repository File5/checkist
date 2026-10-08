import { describe, expect, it } from 'vitest'
import { dateRange, glue, NBSP, numbered } from './text.ts'

describe('dateRange', () => {
  it('glues the dash to the first date and lets the second one move as a whole', () => {
    expect(dateRange('01.09.2026', '30.09.2026')).toBe('01.09.2026\u00a0— 30.09.2026')
  })

  it('uses one em dash and no other dash', () => {
    const text = dateRange('a', 'b')
    expect(text.match(/[-‐‑‒–—―]/g)).toEqual(['—'])
    expect(text.indexOf(' ')).toBe(text.indexOf('—') + 1)
  })
})

describe('glue', () => {
  it('joins a number with its word by a non-breaking space', () => {
    expect(glue(18, 'покупок')).toBe('18\u00a0покупок')
    expect(glue('вырезка', 2)).toBe(`вырезка${NBSP}2`)
    expect(glue(0, 'чеков')).toBe('0\u00a0чеков')
  })

  it('skips empty parts and keeps the spaces inside a part', () => {
    expect(glue('', 'Чек', '')).toBe('Чек')
    expect(glue()).toBe('')
    expect(glue('с 1', 'по 2')).toBe('с 1\u00a0по 2')
  })
})

describe('numbered', () => {
  it('glues the word to the number sign', () => {
    expect(numbered('Чек', 12)).toBe('Чек\u00a0№12')
    expect(numbered('Фото', '3')).toBe('Фото\u00a0№3')
    expect(numbered('чек', 7)).not.toContain(' ')
  })
})
