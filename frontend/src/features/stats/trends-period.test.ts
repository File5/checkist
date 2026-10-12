import { describe, expect, it } from 'vitest'
import {
  checkPeriod, fieldValue, monthNumber, monthOfDate, parseMonthField, parsePeriodPhrase, periodHref, periodText, presetChoices, presetPeriod,
  resolvePeriod, shiftMonth,
} from './trends-period'

const nb = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')
const now = '2026-10'

describe('months', () => {
  it('shifts across years and reads a local date', () => {
    expect([shiftMonth('2026-01', -1), shiftMonth('2026-10', -59), shiftMonth('2025-12', 1), shiftMonth('2026-10', 0)])
      .toEqual(['2025-12', '2021-11', '2026-01', '2026-10'])
    expect(monthOfDate(new Date(2026, 0, 31))).toBe('2026-01')
  })
  it('resolves the period of the address: from … to, the older months, the default 12', () => {
    expect(resolvePeriod({ from: '2026-05', to: '2026-10', months: 24 }, now)).toEqual({ from: '2026-05', to: '2026-10' })
    expect(resolvePeriod({ months: 6 }, now)).toEqual({ from: '2026-05', to: '2026-10' })
    expect(resolvePeriod({}, now)).toEqual({ from: '2025-11', to: '2026-10' })
  })
  it('writes the period in words with the number of months', () => {
    expect(nb(periodText({ from: '2026-05', to: '2026-10' }))).toBe('май 2026 — октябрь 2026, 6 месяцев')
    expect(nb(periodText({ from: '2026-09', to: '2026-09' }))).toBe('сентябрь 2026, 1 месяц')
    expect(nb(periodText({ from: '2024-11', to: '2026-10' }))).toBe('ноябрь 2024 — октябрь 2026, 24 месяца')
  })
  it('keeps the category and closes the opened month when the period changes', () => {
    expect(periodHref({ category: 3, month: '2026-08', months: 24 }, { from: '2026-05', to: '2026-10' }))
      .toBe('/stats/trends?from=2026-05&to=2026-10&category=3')
  })
})

describe('ready periods', () => {
  it('fills from … to for every chip and marks the shown period', () => {
    const choices = presetChoices({}, now, '2025-03')
    expect(choices.map((choice) => [nb(choice.label), choice.href, choice.active])).toEqual([
      ['3 месяца', '/stats/trends?from=2026-08&to=2026-10', false],
      ['6 месяцев', '/stats/trends?from=2026-05&to=2026-10', false],
      ['12 месяцев', '/stats/trends?from=2025-11&to=2026-10', true],
      ['24 месяца', '/stats/trends?from=2024-11&to=2026-10', false],
      ['Этот год', '/stats/trends?from=2026-01&to=2026-10', false],
      ['Прошлый год', '/stats/trends?from=2025-01&to=2025-12', false],
      ['Всё время', '/stats/trends?from=2025-03&to=2026-10', false],
    ])
    expect(presetChoices({ months: 6 }, now, null).filter((choice) => choice.active).map((choice) => choice.key)).toEqual(['m6'])
  })
  it('«Всё время» waits for the range, is off without receipts and is cut to 60 months', () => {
    expect(presetPeriod('all', now, undefined)).toBeNull()
    expect(presetPeriod('all', now, null)).toBeNull()
    expect(presetPeriod('all', now, '2019-01')).toEqual({ from: '2021-11', to: '2026-10' })
    expect(presetChoices({}, now, '2019-01').at(-1)?.clipped).toBe(true)
    expect(presetPeriod('all', now, '2027-02')).toEqual({ from: now, to: now })
    expect(presetPeriod('this-year', '2026-01')).toEqual({ from: '2026-01', to: '2026-01' })
  })
})

describe('the fields «С» and «По»', () => {
  it('reads a month as people type it', () => {
    expect(['05.2026', '5.2026', '05/2026', '2026-05', ' 2026-5 ', 'май 2026', 'Мая 2026', 'сент. 2026'].map(parseMonthField))
      .toEqual(['2026-05', '2026-05', '2026-05', '2026-05', '2026-05', '2026-05', '2026-05', '2026-09'])
    expect(['', '13.2026', '00.2026', '05.26', '1900-12', 'машина 2026', '2026', '05.2026.'].map(parseMonthField)).toEqual(Array(8).fill(null))
    expect([monthNumber('Ёлка'), monthNumber('МАЯ'), monthNumber('февр.')]).toEqual([null, 5, 2])
  })
  it('shows a month in the field of its kind', () => {
    expect([fieldValue('2026-05', true), fieldValue('2026-05', false)]).toEqual(['2026-05', '05.2026'])
  })
  it('checks the period in Russian: both months, «По» not before «С», at most 60 months', () => {
    expect(checkPeriod({ from: '05.2026', to: '2026-10' })).toEqual({ period: { from: '2026-05', to: '2026-10' } })
    expect(checkPeriod({ from: '', to: ' ' })).toEqual({ errors: { from: 'Укажите месяц «С».', to: 'Укажите месяц «По».' } })
    expect(checkPeriod({ from: '13.2026', to: '10.2026' })).toEqual({ errors: { from: 'Месяц — как 05.2026, 2026-05 или «май 2026»; год не раньше 1901.' } })
    expect(checkPeriod({ from: '10.2026', to: '05.2026' })).toEqual({ errors: { to: '«По» не может быть раньше «С».' } })
    const long = checkPeriod({ from: '01.2020', to: '10.2026' })
    expect('errors' in long && nb(long.errors.from ?? '')).toBe('Не больше 60 месяцев, а здесь 82 месяца.')
    expect(checkPeriod({ from: '11.2021', to: '10.2026' })).toEqual({ period: { from: '2021-11', to: '2026-10' } })
  })
})

describe('a period in words', () => {
  it.each([
    ['последние 9 месяцев', '2026-02', '2026-10'],
    ['за 3 мес.', '2026-08', '2026-10'],
    ['12 месяцев', '2025-11', '2026-10'],
    ['полгода', '2026-05', '2026-10'],
    ['последний месяц', '2026-10', '2026-10'],
    ['2026', '2026-01', '2026-10'],
    ['2025 год', '2025-01', '2025-12'],
    ['2024–2025', '2024-01', '2025-12'],
    ['этот год', '2026-01', '2026-10'],
    ['прошлый год', '2025-01', '2025-12'],
    ['май–октябрь 2026', '2026-05', '2026-10'],
    ['май - октябрь 2026 года', '2026-05', '2026-10'],
    ['с ноября 2025 по март 2026', '2025-11', '2026-03'],
    ['ноябрь — март 2026', '2025-11', '2026-03'],
    ['май 2025 – февраль', '2025-05', '2026-02'],
    ['март–июнь', '2026-03', '2026-06'],
    ['ноябрь–декабрь', '2025-11', '2025-12'],
    ['05.2026–10.2026', '2026-05', '2026-10'],
    ['2026-05 - 2026-10', '2026-05', '2026-10'],
    ['сентябрь 2026', '2026-09', '2026-09'],
    ['декабрь', '2025-12', '2025-12'],
  ])('«%s» → %s … %s', (phrase, from, to) => {
    expect(parsePeriodPhrase(phrase, now)).toEqual({ from, to })
  })
  it.each(['', 'вчера', '2027', '2026–2024', 'май–машина 2026', '0 месяцев', '13.2026', 'май 1800'])('does not guess «%s»', (phrase) => {
    expect(parsePeriodPhrase(phrase, now)).toBeNull()
  })
})
