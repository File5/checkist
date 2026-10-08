import { describe, expect, it } from 'vitest'
import { formatAmount, formatIndex, formatObservedAt, formatPercent, formatPrice, formatPurchasedOn, formatQuantity, formatUnit } from './format'

describe('exact ru-RU Decimal formatting', () => {
  it.each([
    ['1234567.80', '1\u00a0234\u00a0567,80\u00a0RUB'], ['-1234.50', '-1\u00a0234,50\u00a0EUR'],
    ['0.00', '0,00\u00a0KZT'], ['-0.00', '0,00\u00a0RUB'], ['1', '1,00\u00a0RUB'],
    ['9999999998990000000001000000.0000', '9\u00a0999\u00a0999\u00a0998\u00a0990\u00a0000\u00a0000\u00a0001\u00a0000\u00a0000,00\u00a0RUB'],
  ])('formats amount %s without losing any digits', (value, expected) => {
    const currency = expected.slice(-3)
    expect(formatAmount(value, currency)).toBe(expected)
  })
  it.each([
    ['130.5882', '130,59\u00a0RUB/л'], ['111.0000', '111,00\u00a0RUB/л'], ['2.5000', '2,50\u00a0RUB/л'],
    ['0.3333', '0,33\u00a0RUB/л'], ['0.0050', '0,01\u00a0RUB/л'], ['0.0000', '0,00\u00a0RUB/л'],
    ['-0.0000', '0,00\u00a0RUB/л'], ['0', '0,00\u00a0RUB/л'], ['9.99995', '10,00\u00a0RUB/л'],
    ['189490.0000', '189\u00a0490,00\u00a0RUB/л'], ['-1.0500', '-1,05\u00a0RUB/л'], ['-130.5882', '-130,59\u00a0RUB/л'],
    ['1000.0001', '1\u00a0000,00\u00a0RUB/л'], ['0.0149', '0,01\u00a0RUB/л'],
  ])('formats price %s with exactly two places, explicit currency and actual unit', (value, expected) => {
    expect(formatPrice(value, 'RUB', 'l')).toBe(expected)
  })
  it.each([
    ['0.0049', '0,0049\u00a0RUB/л'], ['-0.0049', '-0,0049\u00a0RUB/л'], ['0.0010', '0,001\u00a0RUB/л'],
    ['0.00495', '0,005\u00a0RUB/л'], ['0.00004', '0,00\u00a0RUB/л'],
  ])('keeps up to four places for the non-zero price %s that two places would show as zero', (value, expected) => {
    expect(formatPrice(value, 'RUB', 'l')).toBe(expected)
  })
  it.each([
    ['1.2404', '1,2404'], ['1.0000', '1,0000'], ['1.24', '1,2400'], ['1', '1,0000'], ['0.99995', '1,0000'],
    ['1234.5', '1\u00a0234,5000'], [null, '—'], ['bad', '—'],
  ])('formats index %s with exactly four places', (value, expected) => {
    expect(formatIndex(value)).toBe(expected)
  })
  it('does not invent a unit when none was supplied', () => {
    expect(formatPrice('1.0000', 'EUR')).toBe('1,00\u00a0EUR')
    expect(formatPrice('1.0000', 'EUR', null)).toBe('1,00\u00a0EUR')
    expect(formatQuantity('1.000')).toBe('1')
  })
  it.each([
    ['850.000', '850\u00a0мл'], ['-1234.567', '-1\u00a0234,567\u00a0мл'],
    ['0.001', '0,001\u00a0мл'], ['0.000', '0\u00a0мл'],
  ])('formats quantity %s up to three places', (value, expected) => {
    expect(formatQuantity(value, 'ml')).toBe(expected)
  })
  it('rounds excess display precision half-up using digits, including carry and negative sign', () => {
    expect(formatAmount('999.995', 'RUB')).toBe('1\u00a0000,00\u00a0RUB')
    expect(formatAmount('-999.995', 'RUB')).toBe('-1\u00a0000,00\u00a0RUB')
    expect(formatPrice('9.99995', 'EUR')).toBe('10,00\u00a0EUR')
    expect(formatQuantity('-0.0005', 'kg')).toBe('-0,001\u00a0кг')
  })
  it('formats signed and nullable percent values', () => {
    expect(formatPercent('-3.81')).toBe('-3,81\u00a0%')
    expect(formatPercent('0.00')).toBe('0,00\u00a0%')
    expect(formatPercent(null)).toBe('—')
  })
  it.each([null, '', 'NaN', 'Infinity', '1e3', '1,00', '--1', '.5', ' 1.00 '])('keeps invalid/missing Decimal %# distinct from zero', (value) => {
    expect(formatAmount(value, 'RUB')).toBe('—')
    expect(formatPrice(value, 'EUR', 'kg')).toBe('—')
    expect(formatQuantity(value, 'pcs')).toBe('—')
  })
  it.each([
    ['pcs', 'шт'], ['g', 'г'], ['kg', 'кг'], ['ml', 'мл'], ['l', 'л'], ['m', 'м'], [null, '—'],
  ] as const)('labels unit %s', (unit, expected) => { expect(formatUnit(unit)).toBe(expected) })
})

describe('calendar dates and moments', () => {
  it.each([
    ['2026-10-04', '04.10.2026'], ['2024-02-29', '29.02.2024'], ['2000-02-29', '29.02.2000'],
    ['0001-01-01', '01.01.0001'], ['2026-03-29', '29.03.2026'],
  ])('formats purchased_on %s directly without UTC shifting', (date, expected) => {
    expect(formatPurchasedOn(date)).toBe(expected)
  })
  it.each([null, '2026-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-1-01', '2026-10-04T00:00:00Z'])('rejects invalid calendar date %#', (value) => {
    expect(formatPurchasedOn(value)).toBe('—')
  })
  it('uses store timezone, including midnight crossing and UTC fractional seconds', () => {
    expect(formatObservedAt('2026-10-03T22:30:00.123456Z', 'Europe/Berlin')).toBe('04.10.2026,\u00a000:30')
    expect(formatObservedAt('2026-10-04T01:30:00Z', 'America/Los_Angeles')).toBe('03.10.2026,\u00a018:30')
  })
  it('follows daylight saving changes in the store timezone', () => {
    expect(formatObservedAt('2026-03-29T00:30:00Z', 'Europe/Berlin')).toBe('29.03.2026,\u00a001:30')
    expect(formatObservedAt('2026-03-29T01:30:00Z', 'Europe/Berlin')).toBe('29.03.2026,\u00a003:30')
  })
  it.each([undefined, null, '', 'Unknown/Zone', 'Europe/Invalid', ' '])('falls back to explicitly labelled UTC for timezone %#', (timezone) => {
    expect(formatObservedAt('2026-10-03T22:30:00Z', timezone)).toBe('03.10.2026,\u00a022:30\u00a0UTC')
  })
  it('leaves no breakable space in a moment or a calendar date', () => {
    expect(formatObservedAt('2026-10-03T22:30:00Z', 'Europe/Berlin')).not.toContain(' ')
    expect(formatObservedAt('2026-10-03T22:30:00Z', null)).not.toContain(' ')
    expect(formatPurchasedOn('2026-10-04')).toBe('04.10.2026')
  })
  it.each([null, '', 'bad', '2026-02-30T00:00:00Z', '2026-10-04T24:00:00Z', '2026-10-04T00:60:00Z', '2026-10-04T00:00:00+02:00'])('rejects invalid UTC moment %# safely', (value) => {
    expect(formatObservedAt(value, 'Unknown/Zone')).toBe('—')
  })
})
