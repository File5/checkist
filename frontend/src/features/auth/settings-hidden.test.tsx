import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isReceipt } from '../../api/receipts-schema'
import { isMe } from '../../api/session-schema'
import { isSettingsAnswer } from '../../api/settings'
import { parseRoute } from '../../navigation/routes'
import { HiddenChip } from '../receipts/SpendDays'
import { hideTexts } from '../receipts/hide-texts'
import { ReceiptHideView } from '../receipts/ReceiptHideAction'
import { rowMeta, withHidden } from '../receipts/spends'
import { receiptParams } from '../receipts/state'
import { SettingsView } from './SettingsSection'
import { settingsTexts } from './settings-texts'
import type { SettingsState } from './SettingsSection'

const ready = (currency: string | null, extra: Partial<Extract<SettingsState, { kind: 'ready' }>> = {}): SettingsState => ({
  kind: 'ready', currencies: [{ code: 'EUR', name: 'Евро' }, { code: 'KZT', name: 'Казахстанский тенге' }], currency, saving: false, notice: null, ...extra,
})

describe('account settings', () => {
  it('shows the main currency select with every known currency and the name hint', () => {
    const html = renderToStaticMarkup(<SettingsView state={ready('KZT')} onCurrency={() => {}} />)
    expect(html).toContain(settingsTexts.heading)
    expect(html).toContain(settingsTexts.currency)
    expect(html).toContain('KZT — Казахстанский тенге')
    expect(html).toContain(settingsTexts.none)
  })

  it('announces the saved value and the loading state', () => {
    const saved = renderToStaticMarkup(<SettingsView state={ready('EUR', { notice: { kind: 'saved', text: settingsTexts.saved('EUR') } })} onCurrency={() => {}} />)
    expect(saved).toContain('Основная валюта — EUR.')
    expect(renderToStaticMarkup(<SettingsView state={{ kind: 'loading' }} onCurrency={() => {}} />)).toContain('Загружаем')
  })

  it('reads settings in «Я» and the settings answer', () => {
    const me = { mode: 'accounts', user: { id: 1, username: 'a', is_staff: false }, household: null, permissions: { moderate_catalog: false }, csrf_token: 'x'.repeat(64) }
    expect(isMe(me)).toBe(true)
    expect(isMe({ ...me, is_head: true, settings: { default_currency: 'KZT' } })).toBe(true)
    expect(isMe({ ...me, settings: { default_currency: 'kzt' } })).toBe(false)
    expect(isSettingsAnswer({ default_currency: null, currencies: [{ code: 'EUR', name: 'Евро' }] })).toBe(true)
  })
})

describe('hidden payments', () => {
  it('offers the head hide or show with the explanation in the sheet', () => {
    const html = renderToStaticMarkup(<ReceiptHideView hidden={false} open busy={false} failure={null} onOpen={() => {}} onClose={() => {}} onConfirm={() => {}} />)
    expect(html).toContain(hideTexts.hide)
    const shown = renderToStaticMarkup(<ReceiptHideView hidden open={false} busy={false} failure={null} onOpen={() => {}} onClose={() => {}} onConfirm={() => {}} />)
    expect(shown).toContain(hideTexts.show)
    expect(shown).toContain('data-receipt-hidden')
    expect(hideTexts.hideHint).toContain('Платёж пропадёт у всей семьи и не попадёт в суммы и лимиты')
  })

  it('shows the chip «Показать скрытые» only to the head', () => {
    const query = { page: 1 }
    expect(renderToStaticMarkup(<HiddenChip query={query} head={false} />)).toBe('')
    const html = renderToStaticMarkup(<HiddenChip query={query} head />)
    expect(html).toContain('Показать скрытые')
    expect(html).toContain('hidden=1')
    expect(renderToStaticMarkup(<HiddenChip query={{ page: 1, hidden: 1 }} head />)).toContain('aria-current="true"')
  })

  it('keeps the filter in the address and the request', () => {
    expect(parseRoute('http://x/receipts?hidden=1')).toMatchObject({ kind: 'receipts', query: { hidden: 1 } })
    expect(withHidden({ page: 3, hidden: 1 }, false)).toEqual({ page: 1 })
    expect(receiptParams({ page: 1, hidden: 1 })).toMatchObject({ hidden: '1' })
    expect(receiptParams({ page: 1 })).not.toHaveProperty('hidden')
  })

  it('marks a hidden row and checks the field from the server', () => {
    const receipt = { hidden: true, source: 'manual', note: '', lines_count: 1, operation: 'sale', owner: 'a' }
    expect(rowMeta(receipt as never, false)[0]).toBe('скрыто')
    expect(isReceipt({ hidden: 'yes' })).toBe(false)
  })
})
