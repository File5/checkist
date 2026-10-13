import { afterEach, describe, expect, it } from 'vitest'
import { formatPrice } from './format'
import {
  baseTwin, centsWholeUnits, formatApproxMoney, formatCents, formatCentsNumber, formatMoney, formatMoneyNumber, formatMoneyWithBase, moneyCents,
  moneyWholeUnits, currencySymbol,
} from './money'
import { setMoneyDigits } from './money-digits'

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
    expect(formatMoney('4500', 'KZT')).toBe(`4${n}500${n}₸`)
    expect(formatMoney('4500', 'UZS')).toBe(`4${n}500${n}UZS`)
    expect(currencySymbol('USD')).toBe('$')
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
    expect(formatCents(-1n, 'KZT')).toBe(`-1${n}₸`)
  })
})

describe('the same amounts in whole units when the mode is named', () => {
  it.each([
    ['9821.47', `9${n}822`], ['0.01', '1'], ['10.00', '10'], ['10', '10'], ['10.001', '11'], ['0', '0'], ['-0.00', '0'],
    ['-0.40', '-1'], ['-12.25', '-13'], ['999.995', `1${n}000`], ['1234567.89', `1${n}234${n}568`],
  ])('%s → %s', (value, expected) => {
    expect(formatMoneyNumber(value, 'whole')).toBe(expected)
    // Without the argument the choice of the device decides, and a test starts with the default.
    expect(formatMoneyNumber(value)).toBe(expected)
  })

  it('keeps the currency, the dash and the cents helpers', () => {
    expect(formatMoney('4500', 'KZT', 'whole')).toBe(`4${n}500${n}₸`)
    expect(formatMoney('4499.10', 'KZT', 'whole')).toBe(`4${n}500${n}₸`)
    expect(formatMoney(null, 'KZT', 'whole')).toBe('—')
    expect(formatCentsNumber(150050n, 'whole')).toBe(`1${n}501`)
    expect(formatCents(-1n, 'KZT', 'whole')).toBe(`-1${n}₸`)
    expect(formatApproxMoney('8978.52', 'KZT', 'whole')).toBe(`≈${n}8${n}979${n}₸`)
  })
})

describe('money with cents: exactly two places («Суммы: С копейками»)', () => {
  it.each([
    ['9821.47', `9${n}821,47`], ['10', '10,00'], ['10.00', '10,00'], ['12.3', '12,30'], ['12.5', '12,50'], ['0', '0,00'], ['0.00', '0,00'],
    ['-0.00', '0,00'], ['-0.40', '-0,40'], ['-12.25', '-12,25'], ['-12.255', '-12,26'], ['-0.004', '0,00'], ['0.004', '0,00'],
    ['0.005', '0,01'], ['-0.005', '-0,01'], ['0.01', '0,01'], ['10.001', '10,00'], ['999.995', `1${n}000,00`], ['999.994', '999,99'],
    ['1234567.89', `1${n}234${n}567,89`], ['-5.00', '-5,00'],
    // What the client itself hands over: no trailing zeros.
    ['3500', `3${n}500,00`], ['1790.5', `1${n}790,50`],
    ['99999999999999999999.01', `99${n}999${n}999${n}999${n}999${n}999${n}999,01`],
    ['99999999999999999999.995', `100${n}000${n}000${n}000${n}000${n}000${n}000,00`],
  ])('%s → %s', (value, expected) => {
    expect(formatMoneyNumber(value, 'cents')).toBe(expected)
  })

  it('glues the currency and keeps an absent or malformed value as a dash', () => {
    expect(formatMoney('4500', 'KZT', 'cents')).toBe(`4${n}500,00${n}₸`)
    expect(formatMoney('9821.47', 'KZT', 'cents')).toBe(`9${n}821,47${n}₸`)
    expect(formatMoney('4500', 'UZS', 'cents')).toBe(`4${n}500,00${n}UZS`)
    expect(formatMoney('12.3', '', 'cents')).toBe('12,30')
    expect(formatMoney('12.3', undefined, 'cents')).toBe('12,30')
    expect(formatMoney('-0.40', 'KZT', 'cents')).toBe(`-0,40${n}₸`)
    for (const value of [null, undefined, '', 'abc', '1e3', '1,5', ' 1', '.5', '+1']) {
      expect(formatMoney(value as string | null, 'RUB', 'cents')).toBe('—')
      expect(formatMoneyNumber(value as string | null, 'cents')).toBe('—')
      expect(moneyCents(value as string | null)).toBeNull()
    }
  })

  it('reads a wire value in cents, half away from zero', () => {
    expect(moneyCents('9821.47')).toBe(982147n)
    expect(moneyCents('10')).toBe(1000n)
    expect(moneyCents('12.5')).toBe(1250n)
    expect(moneyCents('0.005')).toBe(1n)
    expect(moneyCents('-12.255')).toBe(-1226n)
    expect(moneyCents('-0.004')).toBe(0n)
  })

  it('shows exact cents as they are', () => {
    expect(formatCentsNumber(0n, 'cents')).toBe('0,00')
    expect(formatCentsNumber(1n, 'cents')).toBe('0,01')
    expect(formatCentsNumber(100n, 'cents')).toBe('1,00')
    expect(formatCentsNumber(150050n, 'cents')).toBe(`1${n}500,50`)
    expect(formatCentsNumber(-1n, 'cents')).toBe('-0,01')
    expect(formatCentsNumber(-40n, 'cents')).toBe('-0,40')
    expect(formatCentsNumber(28745000n, 'cents')).toBe(`287${n}450,00`)
    expect(formatCents(150050n, 'KZT', 'cents')).toBe(`1${n}500,50${n}₸`)
    expect(formatCents(-1n, 'KZT', 'cents')).toBe(`-0,01${n}₸`)
    expect(formatCents(0n, '', 'cents')).toBe('0,00')
  })

  it('writes the same number as a unit price does', () => {
    for (const value of ['130.5882', '111.0000', '-3.815', '9821.47', '10', '999.995', '2.5000']) {
      expect(formatMoney(value, 'KZT', 'cents')).toBe(formatPrice(value, 'KZT'))
    }
  })
})

describe('an amount converted into the base currency follows the mode', () => {
  it('«≈» and the twin', () => {
    expect(formatApproxMoney('8978.52', 'KZT', 'cents')).toBe(`≈${n}8${n}978,52${n}₸`)
    expect(baseTwin('USD', '8978.52', 'KZT', 'whole')).toBe(`≈${n}8${n}979${n}₸`)
    expect(baseTwin('USD', '8978.52', 'KZT', 'cents')).toBe(`≈${n}8${n}978,52${n}₸`)
    for (const digits of ['whole', 'cents'] as const) {
      expect(baseTwin('KZT', '8978.52', 'KZT', digits)).toBeNull()
      expect(baseTwin('USD', null, 'KZT', digits)).toBeNull()
      expect(baseTwin('USD', undefined, 'KZT', digits)).toBeNull()
      expect(baseTwin('USD', '8978.52', null, digits)).toBeNull()
    }
  })

  it('one line with the twin, or just the amount', () => {
    expect(formatMoneyWithBase('20.00', 'USD', '8978.52', 'KZT', 'whole')).toBe(`20${n}$ · ≈${n}8${n}979${n}₸`)
    expect(formatMoneyWithBase('20.00', 'USD', '8978.52', 'KZT', 'cents')).toBe(`20,00${n}$ · ≈${n}8${n}978,52${n}₸`)
    expect(formatMoneyWithBase('4499.10', 'KZT', '4499.10', 'KZT', 'whole')).toBe(`4${n}500${n}₸`)
    expect(formatMoneyWithBase('4499.10', 'KZT', '4499.10', 'KZT', 'cents')).toBe(`4${n}499,10${n}₸`)
    expect(formatMoneyWithBase('20.00', 'USD', null, 'KZT', 'cents')).toBe(`20,00${n}$`)
  })
})

describe('without the argument the formatters follow the choice of the device', () => {
  afterEach(() => {
    setMoneyDigits('whole')
  })

  it('whole units by default, cents after the choice, and back', () => {
    expect(formatMoney('9821.47', 'KZT')).toBe(`9${n}822${n}₸`)
    setMoneyDigits('cents')
    expect(formatMoney('9821.47', 'KZT')).toBe(`9${n}821,47${n}₸`)
    expect(formatMoneyNumber('10')).toBe('10,00')
    expect(formatCents(150050n, 'KZT')).toBe(`1${n}500,50${n}₸`)
    expect(formatCentsNumber(-40n)).toBe('-0,40')
    expect(formatApproxMoney('8978.52', 'KZT')).toBe(`≈${n}8${n}978,52${n}₸`)
    expect(baseTwin('USD', '8978.52', 'KZT')).toBe(`≈${n}8${n}978,52${n}₸`)
    expect(formatMoneyWithBase('20.00', 'USD', '8978.52', 'KZT')).toBe(`20,00${n}$ · ≈${n}8${n}978,52${n}₸`)
    // A named mode wins over the choice.
    expect(formatMoney('9821.47', 'KZT', 'whole')).toBe(`9${n}822${n}₸`)
    // The whole-unit helpers stay what their names say.
    expect(moneyWholeUnits('9821.47')).toBe(9822n)
    expect(centsWholeUnits(150050n)).toBe(1501n)
    setMoneyDigits('whole')
    expect(formatMoney('9821.47', 'KZT')).toBe(`9${n}822${n}₸`)
  })
})
