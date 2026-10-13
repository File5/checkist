import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dashboardFixture, limitFixture } from '../../api/budget-test-support'
import type { Dashboard } from '../../api/budget'
import type { ReceiptListItem } from '../../api/receipts'
import { publicFixture } from '../../api/recognition-test-support'
import type { Category } from '../../api/types'
import { excludedNote } from '../../lib/base-currency'
import { baseTwin, formatApproxMoney, formatMoneyWithBase } from '../../lib/money'
import { SettingsView } from '../auth/SettingsSection'
import { SpendDays } from '../receipts/SpendDays'
import { groupByDay } from '../receipts/spends'
import { DashboardView } from './DashboardPage'
import { LimitsView } from './LimitsPage'
import { legacyLimit } from './limits-state'

const nb = (text: string) => text.replaceAll(' ', ' ')
const noop = () => {}

describe('money in the family base currency (2026-10-13)', () => {
  it('shows the converted twin beside an amount in another currency only', () => {
    expect(formatApproxMoney('8978.80', 'KZT')).toBe(nb('≈ 8 979 ₸'))
    expect(baseTwin('USD', '8978.80', 'KZT')).toBe(nb('≈ 8 979 ₸'))
    expect(baseTwin('KZT', '1000.00', 'KZT')).toBeNull()
    expect(baseTwin('GBP', null, 'KZT')).toBeNull()
    expect(baseTwin('USD', '8978.80', undefined)).toBeNull()
    expect(formatMoneyWithBase('20.00', 'USD', '8978.80', 'KZT')).toBe(`${nb('20 $')} · ${nb('≈ 8 979 ₸')}`)
    expect(formatMoneyWithBase('20.00', 'USD', null, 'KZT')).toBe(nb('20 $'))
  })
  it('names the spends without a rate instead of dropping them', () => {
    expect(excludedNote(undefined)).toBe('')
    expect(excludedNote([])).toBe('')
    expect(excludedNote([{ currency: 'GBP', receipts_count: 1, total: '5.00' }, { currency: 'RUB', receipts_count: 12, total: '1000.10' }]))
      .toBe(`Нет курса Нацбанка на дату покупки — в итог не вошли: ${nb('5 £')} (${nb('1 трата')}), ${nb('1 001 ₽')} (${nb('12 трат')}).`)
  })
})

describe('«Главная» in the base currency', () => {
  const data = (): Dashboard => {
    const fixture = dashboardFixture()
    return {
      ...fixture, base_currency: 'KZT', excluded: [{ currency: 'GBP', receipts_count: 1, total: '5.00' }],
      recent: [{ ...fixture.recent[0], total: '20.00', currency: 'USD', base_total: '8978.80' }, fixture.recent[1]],
    }
  }
  it('shows «20 $» with «≈ 8 979 ₸» under it, and the spends without a rate in their own card', () => {
    const html = renderToStaticMarkup(<DashboardView data={data()} today="2026-10" date="2026-10-20" />)
    expect(html).toContain(`<span class="ck-row-amount ck-figures">${nb('20 $')}<span class="dash-recent-twin">${nb('≈ 8 979 ₸')}</span></span>`)
    expect(html).toContain(`<span class="ck-row-amount ck-figures">${nb('4 500 ₸')}</span>`)
    expect(html).toContain('<h2 id="dash-unconverted-heading">Без курса</h2>')
    expect(html).toContain('Нет курса Нацбанка на дату покупки — не в итоге')
    expect(html).not.toContain('Другие валюты')
    // One hero: the month in tenge.
    expect(html.match(/ck-hero-figure/g)).toHaveLength(1)
  })
  it('a month with only spends without a rate does not say «трат не было»', () => {
    const html = renderToStaticMarkup(<DashboardView data={{ ...data(), currencies: [] }} today="2026-10" date="2026-10-20" />)
    expect(html).toContain('Без курса')
    expect(html).not.toContain('трат пока нет')
  })
})

const base = { ...(publicFixture('receipts.json') as { results: ReceiptListItem[] }).results[0], categories: undefined }
const receipt = (id: number, fields: Partial<ReceiptListItem>): ReceiptListItem => ({ ...base, id, purchased_on: '2026-10-09', ...fields })

describe('«Траты» keep the original amount', () => {
  const rows = [
    receipt(1, { total: '20.00', currency: 'USD', base_currency: 'KZT', base_total: '8978.80' }),
    receipt(2, { total: '1000.00', currency: 'KZT', base_currency: 'KZT', base_total: '1000.00' }),
    receipt(3, { total: '5.00', currency: 'GBP', base_currency: 'KZT', base_total: null }),
  ]
  it('a day totals what converts in the base currency and keeps a spend without a rate apart', () => {
    expect(groupByDay(rows, '2026-10-12')[0].totals).toEqual([{ currency: 'KZT', total: '9978.80' }, { currency: 'GBP', total: '5.00' }])
  })
  it('a row says «20 $» and «≈ 8 979 ₸»', () => {
    const html = renderToStaticMarkup(<SpendDays receipts={rows} today="2026-10-12" showOwner={false} />)
    expect(html).toContain(`${nb('20 $')}<span class="spends-row-twin">${nb('≈ 8 979 ₸')}</span>`)
    expect(html.match(/spends-row-twin/g)).toHaveLength(1)
  })
})

const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})

describe('«Лимиты» only in the base currency', () => {
  const usd = limitFixture({ id: 9, category_id: 8, category_name: 'Кафе', currency: 'USD', amount: '50.00', base_currency: 'KZT', base_amount: '22447.00' })
  const html = renderToStaticMarkup(<LimitsView categories={[category(3, 'Продукты'), category(8, 'Кафе')]}
    limits={[limitFixture(), usd]} currencies={['KZT']} currency="KZT" base="KZT" family drafts={{}} statuses={{}}
    onCurrency={noop} onAddCurrency={() => undefined} onDraft={noop} onSave={noop} onDelete={noop} />)
  it('offers no other currency and says where the base one is chosen', () => {
    expect(html).not.toContain('Другая валюта')
    expect(html).not.toContain('aria-pressed')
    expect(html).toContain('Лимиты — в основной валюте семьи (KZT)')
    expect(html).toContain('выбирает главный в семье')
  })
  it('shows a limit of another currency converted, ready to move to the base one', () => {
    expect(html).toContain(`<span class="limits-current ck-figures">${nb('50 $')} · ${nb('≈ 22 447 ₸')}</span>`)
    expect(html).toContain('aria-label="Удалить лимит «Кафе»"')
    expect(legacyLimit([limitFixture(), usd], 8, 'KZT')).toBe(usd)
    expect(legacyLimit([limitFixture(), usd, { ...usd, id: 10, currency: 'KZT' }], 8, 'KZT')).toBeUndefined()
  })
})

describe('«Аккаунт»: the base currency of the family', () => {
  const ready = { kind: 'ready' as const, currencies: [{ code: 'KZT', name: 'Тенге' }, { code: 'USD', name: 'Доллар' }], currency: 'KZT', saving: false, notice: null, base: 'USD' }
  it('says the totals and limits are counted in it and who chooses it', () => {
    const member = renderToStaticMarkup(<SettingsView state={ready} onCurrency={noop} family head={false} />)
    expect(member).toContain('Основная валюта семьи — USD: итоги и лимиты считаются в ней. Её выбирает главный в семье.')
    const head = renderToStaticMarkup(<SettingsView state={{ ...ready, currency: 'USD' }} onCurrency={noop} family head />)
    expect(head).toContain('Основная валюта семьи — USD: итоги и лимиты считаются в ней. Её задаёт ваш выбор выше')
    const alone = renderToStaticMarkup(<SettingsView state={{ ...ready, base: 'KZT' }} onCurrency={noop} />)
    expect(alone).toContain('Итоги и лимиты считаются в основной валюте — KZT')
    expect(renderToStaticMarkup(<SettingsView state={{ ...ready, base: undefined }} onCurrency={noop} />)).not.toContain('data-settings-base')
  })
})
