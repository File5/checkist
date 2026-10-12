import { describe, expect, it } from 'vitest'
import { dashboardFixture } from '../../api/budget-test-support'
import {
  badgeLetter, capitalize, categoryIds, categoryTone, cents, compareMonths, dayAndMonth, daysLeftText, dashboardErrorMessage, deviceMonth,
  formatMoney, formatNumber, initials, inMonth, monthIsEmpty, monthTitle, plural, progress, recentMeta, shiftMonth,
} from './dashboard-state'

const nb = (text: string) => text.replaceAll(' ', '\u00a0')

describe('money of the dashboard', () => {
  it('counts cents without Number', () => {
    expect(cents('287450.00')).toBe(28745000n)
    expect(cents('-10.5')).toBe(-1050n)
    expect(cents('99999999999999999.99')).toBe(9999999999999999999n)
    expect(cents('abc')).toBe(0n)
    expect(cents(null)).toBe(0n)
  })
  it('shows kopecks only when there are any and never breaks a value', () => {
    expect(formatMoney('287450.00', 'KZT')).toBe(nb('287 450 KZT'))
    expect(formatMoney('1500.50', 'KZT')).toBe(nb('1 501 KZT'))
    expect(formatMoney(5n, 'EUR')).toBe(nb('1 EUR'))
    expect(formatMoney(-40n, 'EUR')).toBe(nb('-1 EUR'))
    expect(formatMoney('-1200.00', 'KZT')).toBe(nb('-1 200 KZT'))
    expect(formatNumber('92300.00')).toBe(nb('92 300'))
    expect(formatMoney('0.00', 'KZT')).not.toContain(' ')
  })
})

describe('months', () => {
  it('names and shifts months across the year', () => {
    expect(monthTitle('2026-10')).toBe(nb('Октябрь 2026'))
    expect(inMonth('2026-09')).toBe(nb('в сентябре'))
    expect(capitalize(inMonth('2026-05'))).toBe(nb('В мае'))
    expect(dayAndMonth('2026-10-01')).toBe(nb('1 октября'))
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-10', -13)).toBe('2025-09')
    expect(deviceMonth(new Date(2026, 0, 31, 23, 59))).toBe('2026-01')
  })
  it('chooses the Russian plural', () => {
    expect([1, 2, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => plural(n, 'день', 'дня', 'дней')))
      .toEqual(['день', 'дня', 'дней', 'дней', 'дней', 'дней', 'день', 'дня', 'дней', 'день', 'дней'])
    expect(daysLeftText(19)).toBe(nb('ещё 19 дней'))
    expect(daysLeftText(1)).toBe(nb('ещё 1 день'))
  })
})

const plainCompare = (...args: Parameters<typeof compareMonths>) => {
  const result = compareMonths(...args)
  return result && { ...result, text: result.text.replaceAll('\u00a0', ' ') }
}

describe('comparison with the previous month', () => {
  it('says «на 12% меньше, чем в сентябре» for the mockup numbers', () => {
    expect(plainCompare('287450.00', '326100.00', '2026-09')).toEqual({ tone: 'less', text: 'на 12 % меньше, чем в сентябре' })
    // The number stays with «на» and with its percent sign.
    expect(compareMonths('287450.00', '326100.00', '2026-09')?.text).toContain('на\u00a012\u00a0%')
  })
  it('rounds half up and says «больше»', () => {
    expect(plainCompare('105.00', '100.00', '2026-09')).toEqual({ tone: 'more', text: 'на 5 % больше, чем в сентябре' })
    expect(plainCompare('100.50', '100.00', '2026-09')?.text).toBe('на 1 % больше, чем в сентябре')
    expect(plainCompare('300.00', '100.00', '2026-09')?.text).toBe('на 200 % больше, чем в сентябре')
  })
  it('handles equal, nearly equal and a zero previous month', () => {
    expect(plainCompare('100.00', '100.00', '2026-09')).toEqual({ tone: 'same', text: 'столько же, сколько в сентябре' })
    expect(plainCompare('100000.10', '100000.00', '2026-09')).toEqual({ tone: 'same', text: 'почти столько же, сколько в сентябре' })
    expect(plainCompare('100.00', '0.00', '2026-09')).toEqual({ tone: 'new', text: 'в сентябре трат не было' })
    expect(plainCompare('0.00', '0.00', '2026-09')).toBeNull()
    expect(plainCompare('-5.00', '-3.00', '2026-09')).toBeNull()
  })
})

describe('progress against a limit', () => {
  it('fills by the share and tells what is left', () => {
    expect(progress('92300.00', '120000.00')).toEqual({ percent: 76, over: false, remaining: 2770000n, overBy: 0n })
    expect(progress('0.00', '30000.00')).toEqual({ percent: 0, over: false, remaining: 3000000n, overBy: 0n })
    expect(progress('120000.00', '120000.00')).toEqual({ percent: 100, over: false, remaining: 0n, overBy: 0n })
  })
  it('is full and over above the limit', () => {
    expect(progress('54300.00', '50000.00')).toEqual({ percent: 100, over: true, remaining: 0n, overBy: 430000n })
  })
  it('has no bar without a positive limit, and no negative fill', () => {
    expect(progress('10.00', null)).toBeNull()
    expect(progress('10.00', '0.00')).toBeNull()
    expect(progress('-10.00', '100.00')?.percent).toBe(0)
  })
})

describe('colours, avatars and recent spends', () => {
  it('gives a category a stable colour from 1 to 6', () => {
    expect([1, 3, 5, 6, 7, 12, 13].map(categoryTone)).toEqual([1, 3, 5, 6, 1, 6, 1])
    expect(categoryTone(null)).toBe(0)
    expect(categoryTone(undefined)).toBe(0)
  })
  it('takes initials of usernames', () => {
    expect(initials('andrey')).toBe('A')
    expect(initials('liza')).toBe('L')
    expect(initials('anna_maria')).toBe('AM')
    expect(initials('лиза')).toBe('Л')
    expect(initials('__')).toBe('_')
  })
  it('describes a recent spend', () => {
    const [photo, manual] = dashboardFixture().recent
    expect(recentMeta(photo)).toBe(`liza · ${nb('12 октября')} · ${nb('23 позиции')}`)
    expect(recentMeta(manual)).toBe(`andrey · ${nb('11 октября')} · вручную`)
    expect(recentMeta({ ...photo, lines_count: 1 })).toContain(nb('1 позиция'))
    expect(recentMeta({ ...photo, lines_count: 11 })).toContain(nb('11 позиций'))
    expect(badgeLetter('продукты', 'Magnum')).toBe('П')
    expect(badgeLetter(null, 'magnum')).toBe('M')
    expect(badgeLetter(null, '')).toBe('•')
  })
  it('finds category ids by name for the badges', () => {
    expect(categoryIds(dashboardFixture()).get('Продукты')).toBe(3)
    expect(categoryIds(dashboardFixture()).get('Нет такой')).toBeUndefined()
  })
  it('knows an empty month', () => {
    const data = dashboardFixture()
    expect(monthIsEmpty(data)).toBe(false)
    expect(monthIsEmpty({ ...data, currencies: [] })).toBe(true)
    expect(monthIsEmpty({ ...data, currencies: [{ ...data.currencies[0], spent: '0.00' }] })).toBe(true)
  })
  it('explains failures with local texts', () => {
    expect(dashboardErrorMessage({ reason: 'network' })).toContain('соединение')
    expect(dashboardErrorMessage({ reason: 'invalid_parameter' })).toContain('месяц')
    expect(dashboardErrorMessage({ reason: 'server' })).toBe('Не удалось загрузить траты месяца. Повторите попытку.')
  })
})
