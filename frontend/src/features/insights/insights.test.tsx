import { readdirSync, readFileSync } from 'node:fs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getReview, isAsk, isReview } from '../../api/insights'
import type { Ask, Review, ReviewFigures } from '../../api/insights'
import { aiTexts } from '../../lib/ai'
import { buildRoute, parseRoute } from '../../navigation'
import { AskView } from './AskPage'
import { ReviewView } from './ReviewPage'
import {
  defaultReviewMonth, delta, insightErrorMessage, insightTexts, modelText, monthIsEmpty, outcome, requestFailureMessage, WAIT_MS,
} from './insights-state'

const NBSP = String.fromCharCode(0xa0)
/** Words are compared with ordinary spaces: the screen keeps a number and its sign on one line with no-break ones. */
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const html = (node: ReactElement) => plain(renderToStaticMarkup(node).replace(/<svg\b.*?<\/svg>/g, ''))
const words = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const executor = { available: true, state: 'idle' as const, last_seen_at: null }
const figure = { spent: '540679.83', previous: '469463.83', average: '446531.58', change_previous: '71216.00', change_average: '94148.25' }
const figures = (patch: Partial<ReviewFigures> = {}): ReviewFigures => ({
  ...figure, month: '2026-09', currency: 'KZT',
  categories: [
    { id: 3, name: 'Еда и напитки', spent: '198968.00', previous: '125075.00', average: '120305.00', change_previous: '73893.00', change_average: '78663.00' },
    { id: 1, name: 'Кафе и рестораны', spent: '49819.00', previous: '55533.00', average: null, change_previous: '-5714.00', change_average: null },
  ],
  limit_total: '40000.00', limited_spent: '49819.00',
  limits: [{ category: 'Кафе и рестораны', limit: '40000.00', spent: '49819.00', over: '9819.00' }],
  places: [{ name: 'MAGNUM', spent: '44912.00', count: 2 }],
  without_rate: [],
  ...patch,
})
const review = (patch: Partial<Review> = {}): Review => ({
  id: 7, kind: 'review', month: '2026-09', question: '', status: 'succeeded',
  answer: { summary: 'Больше всего ушло на «Еда и напитки» — 198 968 ₸.', changes: 'Еда выросла на 73 893 ₸.', limits: null,
    advice: ['Сравните цены в MAGNUM и City Market.', '<b>Не</b> берите такси по утрам.'] },
  unverified: [], error: null, created_at: '2026-10-13T09:20:00Z', finished_at: '2026-10-13T09:20:20Z', executor,
  figures: figures(), ...patch,
})
const ask = (patch: Partial<Ask> = {}): Ask => ({
  id: 11, kind: 'ask', month: '2026-10', question: 'Сколько ушло на кафе в сентябре?', status: 'succeeded',
  answer: { answer: 'В сентябре на кафе ушло 49 819 ₸.' }, unverified: [], error: null,
  created_at: '2026-10-13T09:20:00Z', finished_at: '2026-10-13T09:20:20Z', executor, ...patch,
})

describe('words and states of the month review and the questions', () => {
  it('says what a failed request, a refusal of the family AI and a waiting one mean', () => {
    expect(insightErrorMessage('invalid_output')).toBe(insightTexts.failed)
    expect(insightErrorMessage('expired')).toBe(insightTexts.expired)
    expect(insightErrorMessage('anything')).toBe(insightTexts.failed)
    expect(requestFailureMessage({ reason: 'ai_disabled' })).toBe(aiTexts.disabled)
    expect(requestFailureMessage({ reason: 'ai_quota', resetsAt: '2026-10-14T00:00:00Z' }, new Date('2026-10-13T10:00:00Z')))
      .toMatch(/^На сегодня запросы к ИИ закончились\. Снова можно/)
    expect(requestFailureMessage({ reason: 'parse_limit' })).toBe(insightTexts.limit)
    expect(requestFailureMessage({ reason: 'network' })).toMatch(/Не удалось связаться с сервером/)
    expect(outcome(review())).toEqual({ kind: 'done' })
    expect(outcome(review({ status: 'failed', answer: null, error: { code: 'timeout', message: '…' } }))).toEqual({ kind: 'failed', message: insightTexts.timeout })
    expect(outcome(review({ status: 'queued', answer: null, executor: { ...executor, state: 'absent', available: false } })))
      .toEqual({ kind: 'failed', message: insightTexts.unavailable })
    expect(outcome(review({ status: 'running', answer: null }))).toEqual({ kind: 'working' })
    expect(outcome(review({ status: 'running', answer: null }), WAIT_MS)).toEqual({ kind: 'failed', message: insightTexts.slow })
  })

  it('keeps a number of the model with its groups and its sign on one line, and marks a change of money', () => {
    expect(modelText('ушло 45 301 ₸, на 12 месяцев, 1 200 350 KZT, 15 %')).toBe(`ушло 45${NBSP}301${NBSP}₸, на 12 месяцев, 1${NBSP}200${NBSP}350${NBSP}KZT, 15${NBSP}%`)
    expect(plain(delta('73893.00', 'KZT')?.text ?? '')).toBe('▲ 73 893 ₸')
    expect(delta('-5714.40', 'KZT')).toEqual({ tone: 'less', text: `▼${NBSP}5${NBSP}715${NBSP}₸` })
    expect(delta('0.00', 'KZT')?.tone).toBe('same')
    expect(delta(null, 'KZT')).toBeNull()
    expect(monthIsEmpty(figures({ spent: '0.00', categories: [] }))).toBe(true)
    expect(monthIsEmpty(figures())).toBe(false)
    expect(defaultReviewMonth(new Date(2026, 0, 3))).toBe('2025-12')
  })

  it('opens /review and /ask by their addresses: a wrong month is dropped, the question is kept', () => {
    expect(parseRoute('/review?month=2026-09')).toEqual({ kind: 'review', month: '2026-09' })
    expect(parseRoute('/review?month=2026-13')).toEqual({ kind: 'review' })
    expect(parseRoute('/review')).toEqual({ kind: 'review' })
    expect(parseRoute('/ask?q=%20Сколько%20на%20кафе%3F%20')).toEqual({ kind: 'ask', q: 'Сколько на кафе?' })
    expect(parseRoute('/ask?q=')).toEqual({ kind: 'ask' })
    expect(buildRoute({ kind: 'review', month: '2026-09' })).toBe('/review?month=2026-09')
    expect(buildRoute({ kind: 'ask', q: 'кафе & такси' })).toBe('/ask?q=%D0%BA%D0%B0%D1%84%D0%B5+%26+%D1%82%D0%B0%D0%BA%D1%81%D0%B8')
    expect(buildRoute({ kind: 'ask' })).toBe('/ask')
  })

  it('accepts an answer only with succeeded and an error only with failed', async () => {
    expect(isReview(review())).toBe(true)
    expect(isReview(review({ status: 'failed' }))).toBe(false)
    expect(isAsk(ask())).toBe(true)
    expect(isAsk(ask({ status: 'queued' }))).toBe(false)
    expect(isAsk({ ...ask(), kind: 'review' })).toBe(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getReview('2026-9')).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['month'] })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('markup of the month review', () => {
  it('shows the server figures next to the text of the model, which stays plain text', () => {
    const markup = html(<ReviewView month="2026-09" figures={figures()} review={review()} status={{ kind: 'idle' }} current="2026-10" />)
    const text = words(markup)
    expect(text).toContain('Сентябрь 2026 Потрачено в сентябре 540 680 ₸ На 15 % больше, чем в августе')
    expect(text).toContain('Среднее прошлых месяцев — 446 532 ₸ ▲ 94 149 ₸')
    expect(text).toContain('Еда и напитки Август: 125 075 ₸ · среднее 120 305 ₸ 198 968 ₸ ▲ 73 893 ₸')
    expect(text).toContain('Кафе и рестораны Август: 55 533 ₸ 49 819 ₸ ▼ 5 714 ₸')
    expect(text).toContain('Кафе и рестораны Лимит 40 000 ₸ · сверх на 9 819 ₸ 49 819 ₸')
    expect(text).toContain('MAGNUM 2 траты 44 912 ₸')
    expect(text).toContain('Советы')
    // The words of the model are text: a tag in them is shown, never drawn.
    expect(markup).toContain('&lt;b&gt;Не&lt;/b&gt; берите такси по утрам.')
    expect(markup).toContain('<a class="ck-round" aria-label="Предыдущий месяц" href="/review?month=2026-08">')
    expect(markup).toContain('href="/review?month=2026-10"')
    expect(markup).toContain('<a class="ins-link" href="/ask">Спросить о тратах</a>')
    expect(markup).not.toContain('ins-unverified')
  })

  it('marks numbers it could not check, says it waits, and shows a refusal of the family AI with the figures', () => {
    const marked = html(<ReviewView month="2026-09" figures={figures()} review={review({ unverified: ['45 300,50'] })} status={{ kind: 'idle' }} />)
    expect(words(marked)).toContain(`${insightTexts.unverified} 45 300,50.`)
    const waiting = html(<ReviewView month="2026-09" figures={figures()} review={null} status={{ kind: 'working', refreshing: false }} current="2026-09" />)
    expect(waiting).toContain(`<p class="ins-status" role="status">${insightTexts.working}</p>`)
    expect(waiting).toContain('disabled="">Обновить</button>')
    expect(waiting).not.toContain('Следующий месяц')
    const refused = html(<ReviewView month="2026-09" figures={figures()} review={null} status={{ kind: 'message', text: aiTexts.disabled }} />)
    expect(refused).toContain(`role="alert">${aiTexts.disabled}</p>`)
    expect(words(refused)).toContain('540 680 ₸')
    const empty = html(<ReviewView month="2026-09" figures={figures({ spent: '0.00', previous: '0.00', categories: [], limits: [], places: [] })} review={null} status={{ kind: 'idle' }} />)
    expect(empty).toContain(insightTexts.empty)
    expect(empty).not.toContain('Обновить')
  })
})

describe('markup of a question', () => {
  it('shows the answer, the person\'s past questions and a refusal', () => {
    const past = [ask({ id: 12, question: 'Почему этот месяц дороже?', answer: { answer: 'Еда выросла на 73 893 ₸.' } }), ask()]
    const markup = html(<AskView text="" current={{ question: ask().question, row: ask(), message: null }} history={past} />)
    const text = words(markup)
    expect(text).toContain('Сколько ушло на кафе в сентябре? В сентябре на кафе ушло 49 819 ₸.')
    expect(text).toContain('Прошлые вопросы Разбор месяца Почему этот месяц дороже? Еда выросла на 73 893 ₸.')
    expect(markup.match(/Сколько ушло на кафе в сентябре\?/g)).toHaveLength(1)  // the current one is not repeated below
    expect(markup).toContain('maxLength="300"')
    expect(markup).toContain('disabled="">Спросить</button>')  // nothing typed
    const waiting = html(<AskView text="и ещё" current={{ question: 'Сколько?', row: null, message: null }} history={[]} />)
    expect(waiting).toContain(`role="status">${insightTexts.thinking}</p>`)
    expect(waiting).toContain('readOnly=""')
    const refused = html(<AskView text="Сколько?" current={{ question: 'Сколько?', row: null, message: aiTexts.disabled }} history={[]} />)
    expect(refused).toContain(`role="alert">${aiTexts.disabled}</p>`)
    expect(refused).not.toContain('disabled="">Спросить')
  })
})

describe('code of the screens', () => {
  const folder = new URL('./', import.meta.url)
  const sources = readdirSync(folder).filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.tsx'))
    .map((name) => readFileSync(new URL(name, folder), 'utf8'))
  const css = readFileSync(new URL('./Insights.css', import.meta.url), 'utf8')

  it('never draws the words of the model as markup', () => {
    for (const source of sources) expect(source).not.toContain('dangerouslySetInnerHTML')
  })
  it('takes colours and sizes of text only from tokens', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    for (const size of css.match(/font-size:[^;]+/g) ?? []) expect(size).toMatch(/^font-size: var\(--ck-text-[a-z0-9]+\)$/)
  })
})
