import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStatementDetail, saveStatement, uploadStatement } from '../../api/statements'
import { rowFixture, ruleFixture, statementFixture } from '../../api/statements-test-support'
import { clearRecognitionCsrf } from '../../api/local'
import { publicFixture } from '../../api/recognition-test-support'
import type { Category } from '../../api/types'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { headerAction } from '../../menu/back-target'
import { historyMeta, ruleMeta, syncEdits } from './statement-state'
import { StatementView } from './StatementPage'
import type { StatementViewProps } from './StatementPage'
import { RulesView } from './RulesPage'
import { UploadStatementView } from './UploadStatementPage'
import { statementFailure } from './statement-texts'

const noop = () => {}
const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const categories = [category(1, 'Еда и напитки'), category(3, 'Кафе и рестораны')]
const view = (extra: Partial<StatementViewProps> = {}) => {
  const detail = extra.detail ?? statementFixture()
  return renderToStaticMarkup(<StatementView detail={detail} edits={syncEdits(detail.rows)} categories={categories} open={null} saving={false}
    notice={null} failure={null} onOpen={noop} onToggle={noop} onCategory={noop} onStore={noop} onSave={noop} onDelete={noop} {...extra} />)
}

describe('statement draft screen', () => {
  it('shows spends checked, questionable rows highlighted, duplicates apart and the rest folded at the bottom', () => {
    const html = view()
    expect(html).toContain('<p class="statement-summary-period">За 13.09')
    expect(html).toContain('<strong>5</strong> к сохранению')
    expect(html).toContain('<strong>3</strong> спорных')
    expect(html.match(/class="statement-row statement-row-review"/g)).toHaveLength(3)
    expect(html).toContain('Категорию предложила модель — проверьте')
    expect(html).toContain('Незнакомый получатель — спрашиваю модель')
    expect(html).toContain('Спрашиваю модель о незнакомых получателях: 1. Можно сохранять, не дожидаясь.')
    expect(html).toContain('<h2 id="statement-duplicates-heading">Уже внесены</h2>')
    expect(html).toContain('Уже внесена: 28 сент. · Кафе Дубль')
    // Folded groups: saved, skipped (transfers, own moves, a refund netted in) and incomings apart.
    expect(html).toMatch(/<details class="ck-panel statement-group"><summary><span>Сохранено: 1<\/span>/)
    expect(html).toMatch(/<summary><span>Пропущено: 3<\/span>/)
    expect(html).toMatch(/<summary><span>Поступления: 2<\/span>/)
    expect(html).toContain('Перевод вам')
    // Five to save, a duplicate and a transfer can be checked; incomings, own moves, refunds and saved rows cannot.
    expect(html.match(/type="checkbox"/g)).toHaveLength(5 + 1 + 1)
    expect(html.match(/checked=""/g)).toHaveLength(4)
    expect(html).toContain('Сохранить 4 траты · 30 150 ₸')
    expect(html).toContain('+35 000 ₸')
    expect(html).toContain('class="statement-actions ck-action-bar"')
  })

  it('opens the editor of a row with the category picker and the place', () => {
    const html = view({ open: 1 })
    expect(html).toContain('aria-expanded="true" aria-controls="statement-row-1-edit"')
    expect(html).toContain('<option value="1" selected="">Еда и напитки</option>')
    expect(html).toMatch(/<input type="text" maxLength="100" autoComplete="off" placeholder="Без места" value="MAGNUM"\/>/)
    expect(html).toContain('<span>Покупка</span> ТОО &quot;MAGNUM CASH&amp;CARRY&quot;')
  })

  it('shows contributions to goals apart and lets a transfer become one', () => {
    const deposit = rowFixture({ id: 40, date: '2026-10-06', amount: '-100000.00', spend: '100000.00', operation: 'Перевод',
      details: 'На Kaspi Депозит', merchant: 'На Kaspi Депозит', kind: 'own_move', state: 'goal', category: null, store_name: null,
      source: 'rule', goal: { id: 30, name: 'Отпуск' } })
    const base = statementFixture()
    const detail = { ...base, rows: [...base.rows, deposit] }
    const html = view({ detail, open: 40 }).replaceAll(String.fromCharCode(0xa0), ' ')
    expect(html).toContain('<h2 id="statement-goals-heading">Взносы в цели</h2>')
    expect(html).toContain('<strong>1</strong> в цели')
    expect(html).toContain('aria-label="Сохранить взносом: На Kaspi Депозит, 100 000 ₸"')
    expect(html).toContain('6 окт. · в цель «Отпуск»')
    expect(html).toContain('href="/goals/30">«Отпуск»</a> — не трата.')
    expect(html).not.toContain('placeholder="Без места" value=""')
    expect(html).toContain('Сохранить 4 траты и 1 взнос')
    const goals = [{ id: 30, name: 'Отпуск' }].map((goal) => ({ ...goal, amount: '1.00', currency: 'KZT', deadline: null, shared: true,
      owner: null, created_by: null, saved: '0.00', percent: 0, remaining: '1.00', reached: false, excluded: [], contributions_count: 0,
      pace: null, need_per_month: null, overdue: false, kind: 'saving' as const, rate: null, capitalization: 'monthly' as const, deposit: null }))
    const transfer = view({ open: 9, goals })
    expect(transfer).toContain('<span>Это взнос в цель</span>')
    expect(transfer).toContain('<option value="30" selected="">Отпуск</option>')
    expect(transfer).toContain('Это взнос — запомнить')
    expect(view({ open: 9 })).toContain('href="/goals">заведите цель</a>')
  })

  it('says when the worker is absent, after a save, and why a save failed', () => {
    const detail = statementFixture({ ai: { waiting: 1, active: true, executor: { available: false, state: 'absent', last_seen_at: null } } })
    expect(view({ detail })).toContain('Исполнитель не запущен — модель сейчас не ответит. Выберите категории сами.')
    expect(view({ notice: 'Сохранено: 4 траты.' })).toContain('<p class="statement-notice" role="status">Сохранено: 4 траты.</p>')
    expect(view({ failure: 'Не получилось.' })).toContain('<p class="statement-status statement-status-error" role="alert">Не получилось.</p>')
    expect(view({ saving: true })).toMatch(/<button type="button" class="statement-save" disabled="">Сохраняю…<\/button>/)
  })
})

describe('upload screen and rules', () => {
  it('offers to pick a PDF and lists the statements uploaded before', () => {
    const summary = { ...statementFixture(), rows: undefined }
    const html = renderToStaticMarkup(<UploadStatementView state={{ kind: 'idle' }} history={[summary]} onFile={noop} />)
    expect(html).toContain('accept="application/pdf,.pdf"')
    expect(html).toContain('Выбрать PDF')
    expect(html).toContain('href="/statements/4"')
    expect(historyMeta(summary)).toBe('13.09 — 12.10.2026 · сохранено 1 из 11 строк')
    const failed = renderToStaticMarkup(<UploadStatementView state={{ kind: 'failed', message: 'Нет.' }} history={[]} onFile={noop} />)
    expect(failed).toContain('role="alert">Нет.</p>')
    expect(failed).not.toContain('Загруженные выписки')
  })

  it('lists the rules and opens the form of a new one', () => {
    const rules = [ruleFixture(), ruleFixture({ id: 2, pattern: 'Мария К.', action: 'skip', category: null, store_name: null, origin: 'learned' })]
    const props = { rules, categories, busy: false, message: null, search: '', onSearch: noop, onOpen: noop, onCreate: noop, onUpdate: noop, onDelete: noop }
    const html = renderToStaticMarkup(<RulesView {...props} open="new" />)
    expect(html).toContain('Добавить правило')
    expect(html).toContain('aria-pressed="true">Категория</button>')
    expect(html).toContain('Олег Б.')
    expect(html).toContain('<span class="statement-learned">выучено</span>')
    expect(ruleMeta(rules[0], new Map())).toBe('→ Аренда · Съёмное жильё')
    expect(ruleMeta(rules[1], new Map())).toBe('пропускать')
    expect(ruleMeta(ruleFixture({ action: 'goal', category: null, store_name: null, goal: { id: 30, name: 'Отпуск' } }), new Map()))
      .toBe('→ взнос в «Отпуск»')
    expect(html).toContain('aria-pressed="false">Взнос в цель</button>')
    expect(renderToStaticMarkup(<RulesView {...props} rules={[]} open={null} />)).toContain('Правил пока нет.')
  })

  it('names refusals by their code only', () => {
    expect(statementFailure({ kind: 'error', reason: 'statement_unsupported_bank' })).toBe('Это не выписка Kaspi Gold или ForteBank. Другие банки пока не поддерживаются.')
    expect(statementFailure({ kind: 'error', reason: 'statement_empty' })).toContain('не нашлось операций')
    expect(statementFailure({ kind: 'error', reason: 'pdf_encrypted' })).toContain('паролем')
  })
})

describe('addresses of the statements', () => {
  it('parses and builds them; a draft goes back to the upload', () => {
    expect(parseRoute('/statements/new')).toEqual({ kind: 'statement-new' })
    expect(parseRoute('/statements/rules')).toEqual({ kind: 'statement-rules' })
    expect(parseRoute('/statements/12')).toEqual({ kind: 'statement', statementId: 12 })
    expect(parseRoute('/statements/abc')).toEqual({ kind: 'not-found', path: '/statements/abc' })
    expect(buildRoute({ kind: 'statement', statementId: 12 })).toBe('/statements/12')
    expect(headerAction({ route: { kind: 'statement', statementId: 12 } })).toEqual({ kind: 'back', to: '/statements/new', label: 'Назад к выпискам' })
  })
})

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })

describe('statements on the wire', () => {
  it('accepts the draft and refuses a broken row', () => {
    expect(isStatementDetail(statementFixture())).toBe(true)
    const body = statementFixture()
    expect(isStatementDetail({ ...body, rows: [{ ...body.rows[0], kind: 'gift' }] })).toBe(false)
    expect(isStatementDetail({ ...body, rows: [{ ...body.rows[0], amount: -18450 }] })).toBe(false)
    expect(isStatementDetail({ ...body, ai: { waiting: 1 } })).toBe(false)
  })

  it('uploads a PDF with the CSRF token and maps a refusal by its code', async () => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json')))
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'statement_unsupported_bank', message: 'private server text' } }, 400))
    const result = await uploadStatement(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }))
    expect(result).toEqual({ kind: 'error', reason: 'statement_unsupported_bank', status: 400 })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/statements/')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeInstanceOf(FormData)
  })

  it('saves the rows as JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json')))
    fetchMock.mockResolvedValueOnce(json({ created: 1, learned: 0, contributed: 0, statement: statementFixture() }))
    const result = await saveStatement(4, [{ id: 1, category: 1, store_name: 'MAGNUM' }])
    expect(result.kind).toBe('ok')
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/statements/4/save/')
    expect(JSON.parse(String(init?.body))).toEqual({ rows: [{ id: 1, category: 1, store_name: 'MAGNUM' }] })
  })
})
