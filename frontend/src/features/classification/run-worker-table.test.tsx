import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classificationRunStatuses, getProductClassificationState } from '../../api/product-classifications'
import type { ClassificationRun, ClassificationRunStatus, ClassificationState } from '../../api/product-classifications'
import { classificationFixture } from '../../api/product-classifications-test-support'
import { executorStates } from '../../api/recognition-types'
import type { ExecutorState } from '../../api/recognition-types'
import { ClassificationView } from './ClassificationPage'
import { runText } from './labels'
import { canRequestRun, stateActive } from './state'
import { records, success } from './test-support'

/**
 * Every run the server can show against every state of the worker: what the person reads, in which tone, whether
 * «Предложить категории» can be pressed and whether the state is polled. The table is the decision; a run status or a
 * worker state added to the types without a row here does not compile, and one left out of the lists below fails.
 */
const runKinds = ['none', 'queued', 'between', 'running', 'succeeded', 'failed', 'cancelled'] as const
type RunKind = typeof runKinds[number]
const workerStates: ExecutorState[] = [...executorStates, 'unknown']
type Line = { text: string; warning: boolean } | undefined
type Row = {
  status: ClassificationRunStatus | null
  /** The state goes on being read every 2 seconds. */
  polled: boolean
  /** «Предложить категории» can be pressed while there are products without a category. */
  button: boolean
  line: Record<ExecutorState, Line>
}

const run = (name: string) => {
  const body = classificationFixture(name) as ClassificationState | ClassificationRun
  return structuredClone('pending_count' in body ? body.run! : body)
}
/** The run of each kind is the server's own example. */
const runs: Record<RunKind, ClassificationRun | null> = {
  none: null,
  queued: run('status-queued.json'),
  between: run('status-between-batches.json'),
  running: run('status-running.json'),
  succeeded: run('status.json'),
  failed: run('run-failed.json'),
  cancelled: run('run-cancelled.json'),
}

const same = (line: Line): Record<ExecutorState, Line> => ({ idle: line, busy: line, absent: line, unknown: line })
const working = (progress: string) => ({ text: `Модель предлагает категории: обработано ${progress}.`, warning: false })
const paused = (progress: string) =>
  ({ text: `Запуск приостановлен: обработано ${progress}. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.`, warning: true })
const table: Record<RunKind, Row> = {
  none: { status: null, polled: false, button: true, line: same(undefined) },
  queued: {
    status: 'queued', polled: true, button: false,
    line: {
      idle: { text: 'Запуск в очереди и начнётся в ближайшие секунды.', warning: false },
      busy: { text: 'Запуск в очереди. Воркер занят другим заданием.', warning: false },
      absent: { text: 'Запуск в очереди. Воркер распознавания не запущен: запуск начнётся, когда воркер запустят.', warning: true },
      unknown: { text: 'Запуск в очереди.', warning: false },
    },
  },
  between: {
    status: 'queued', polled: true, button: false,
    line: {
      idle: working('1 из 2'),
      busy: { text: 'Модель предлагает категории: обработано 1 из 2. Воркер занят другим заданием.', warning: false },
      absent: paused('1 из 2'),
      unknown: working('1 из 2'),
    },
  },
  running: {
    status: 'running', polled: true, button: false,
    // `busy` is also a worker killed during the batch, until its lease ends: nothing more than «the model works» is known.
    line: { idle: working('0 из 2'), busy: working('0 из 2'), absent: paused('0 из 2'), unknown: working('0 из 2') },
  },
  succeeded: {
    status: 'succeeded', polled: false, button: true,
    line: same({ text: 'Запуск завершён: предложено 8, не распознано 1, пропущено 0.', warning: false }),
  },
  failed: {
    status: 'failed', polled: false, button: true,
    line: same({ text: 'Запуск завершился ошибкой: ответ модели не прошёл проверку. Уже предложенные категории сохранены.', warning: true }),
  },
  cancelled: { status: 'cancelled', polled: false, button: true, line: same({ text: 'Запуск отменён.', warning: false }) },
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

/** The body as the server sends it, read by the real adapter: a worker state the client does not know arrives as a new word. */
async function read(kind: RunKind, worker: ExecutorState, unclassified = 2): Promise<ClassificationState> {
  const body = {
    pending_count: 4, unclassified_count: unclassified, auto_suggest: false, run: runs[kind],
    executor: { available: worker !== 'absent', state: worker === 'unknown' ? 'resting' : worker, last_seen_at: null },
  }
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
  const result = await getProductClassificationState()
  if (result.kind !== 'ok') throw new Error(`The adapter refused ${kind} with the worker ${worker}: ${JSON.stringify(result)}`)
  return result.data
}
const noop = () => {}
const view = (state: ClassificationState) => renderToStaticMarkup(<ClassificationView query={{ page: 1 }} state={success(state)} list={success(records())}
  action={{ kind: 'idle' }} onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop} onAction={noop} onOpen={noop} onClose={noop} />)
const startButton = (html: string) => html.match(/<button[^>]*>Предложить категории<\/button>/)![0]
const runLine = (html: string) => html.match(/<p class="(ck-class-warning|ck-class-run)" role="status" aria-live="polite">([^<]*)<\/p>/)

const cells = runKinds.flatMap((kind) => workerStates.map((worker) => [kind, worker] as const))

describe('run × worker: every combination is decided', () => {
  it('covers every run status of the contract — a queued run both before and between its batches — and every worker state', () => {
    expect(new Set(runKinds.map((kind) => table[kind].status))).toEqual(new Set([null, ...classificationRunStatuses]))
    expect(runKinds.map((kind) => runs[kind]?.status ?? null)).toEqual(runKinds.map((kind) => table[kind].status))
    expect([runs.queued!.started_at, runs.queued!.progress.processed]).toEqual([null, 0])
    expect(runs.between!.started_at).not.toBeNull()
    expect(workerStates).toEqual(['idle', 'busy', 'absent', 'unknown'])
    expect(cells).toHaveLength(28)
  })
  it.each(cells)('run %s, worker %s: the text, its tone, the button and the poll', async (kind, worker) => {
    const row = table[kind]
    const expected = row.line[worker]
    const state = await read(kind, worker)
    expect(state.executor.state).toBe(worker)
    expect(runText(state)).toEqual(expected)
    expect(stateActive(state)).toBe(row.polled)
    expect(canRequestRun(state)).toBe(row.button)

    const html = view(state)
    const line = runLine(html)
    if (!expected) expect(line).toBeNull()
    else expect(line?.slice(1)).toEqual([expected.warning ? 'ck-class-warning' : 'ck-class-run', expected.text])
    expect(startButton(html).includes('disabled=""')).toBe(!row.button)
    expect(html).toContain('Ожидают подтверждения: 4. Без категории: 2.')

    // Without products to classify the button is off whatever the run and the worker are, and the block says why.
    const nothing = await read(kind, worker, 0)
    expect(canRequestRun(nothing)).toBe(false)
    expect(runText(nothing)).toEqual(expected)
    const empty = view(nothing)
    expect(startButton(empty)).toContain('disabled=""')
    expect(empty).toContain('Товаров без категории нет.')
  })
})

describe('run × worker: nobody is left without knowing what to do', () => {
  it.each(runKinds.filter((kind) => table[kind].polled))('active run %s without a worker: a warning that names the worker, never ordinary work', (kind) => {
    const line = table[kind].line.absent!
    expect(line.warning).toBe(true)
    expect(line.text).toContain('Воркер распознавания не запущен')
    expect(line.text).toMatch(/когда воркер запустят\.$/)
    expect(line.text).not.toContain('Модель предлагает категории')
    // The other worker states of the same run are no reason for a warning.
    for (const worker of ['idle', 'busy', 'unknown'] as const) expect(table[kind].line[worker]!.warning).toBe(false)
  })
  it('a run that has started never promises to begin, and one that has not never shows progress', () => {
    for (const kind of ['between', 'running'] as const) for (const worker of workerStates) {
      expect(table[kind].line[worker]!.text).not.toContain('начнётся')
      expect(table[kind].line[worker]!.text).toContain('обработано')
    }
    for (const worker of workerStates) expect(table.queued.line[worker]!.text).not.toContain('обработано')
  })
  it('a button that is off is explained by the line of the active run, and a line without a poll leaves the button on', () => {
    for (const kind of runKinds) {
      const row = table[kind]
      expect(row.button).toBe(!row.polled)
      if (row.polled) for (const worker of workerStates) expect(row.line[worker]).toBeDefined()
    }
  })
  it('a finished run and no run do not depend on the worker', () => {
    for (const kind of ['none', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(new Set(workerStates.map((worker) => JSON.stringify(table[kind].line[worker]))).size).toBe(1)
    }
  })
})
