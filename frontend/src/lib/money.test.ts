import { describe, expect, it } from 'vitest'
import { centsWholeUnits, formatCents, formatCentsNumber, formatMoney, formatMoneyNumber, moneyWholeUnits } from './money'

const n = ' '

describe('money is shown in whole units, rounded up', () => {
  it.each([
    ['9821.47', `9${n}822`], ['11692.55', `11${n}693`], ['0.01', '1'], ['10.00', '10'], ['10', '10'],
    ['10.001', '11'], ['0', '0'], ['0.00', '0'], ['-0.00', '0'], ['-0.40', '-1'], ['-12.25', '-13'],
    ['-5.00', '-5'], ['999.995', `1${n}000`], ['1234567.89', `1${n}234${n}568`],
    ['99999999999999999999.01', `100${n}000${n}000${n}000${n}000${n}000${n}000`],
  ])('%s → %s', (value, expected) => {
    expect(formatMoneyNumber(value)).toBe(expected)
  })

  it('glues the currency and keeps an absent or malformed value as a dash', () => {
    expect(formatMoney('4500', 'KZT')).toBe(`4${n}500${n}KZT`)
    expect(formatMoney('4499.10', '₸')).toBe(`4${n}500${n}₸`)
    expect(formatMoney('12.3', '')).toBe('13')
    expect(formatMoney('12.3', undefined)).toBe('13')
    for (const value of [null, undefined, '', 'abc', '1e3', '1,5', ' 1', '.5', '+1']) {
      expect(formatMoney(value as string | null, 'RUB')).toBe('—')
      expect(moneyWholeUnits(value as string | null)).toBeNull()
    }
  })

  it('rounds exact cents the same way', () => {
    expect(centsWholeUnits(0n)).toBe(0n)
    expect(centsWholeUnits(1n)).toBe(1n)
    expect(centsWholeUnits(100n)).toBe(1n)
    expect(centsWholeUnits(101n)).toBe(2n)
    expect(centsWholeUnits(-40n)).toBe(-1n)
    expect(centsWholeUnits(-200n)).toBe(-2n)
    expect(formatCentsNumber(28745000n)).toBe(`287${n}450`)
    expect(formatCentsNumber(150050n)).toBe(`1${n}501`)
    expect(formatCents(-1n, 'KZT')).toBe(`-1${n}KZT`)
  })
})
