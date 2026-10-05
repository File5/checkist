import { describe, expect, it, vi } from 'vitest'
import type { JobDetail } from '../../api/recognition'
import { isJobDetail, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import { createJobActions } from './actions'
import { acceptJob, isActive } from './labels'
import { createPollingRequest } from './polling'

function job(name = 'job-running.json') { const data = publicFixture(name); if (!isJobDetail(data)) throw new Error('Invalid fixture'); return data }
function csrf() { const data = publicFixture('csrf.json'); if (!isRecognitionCsrf(data)) throw new Error('Invalid fixture'); return data }
const lifecycle = () => ({ pause: vi.fn(), resume: vi.fn(), success: vi.fn() })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('cancel/retry state machine', () => {
  it('disables repeated mutations and waits for the actual cancel response', async () => {
    let resolve!: (value: LocalApiResult<JobDetail>) => void
    const mutate = vi.fn(() => new Promise<LocalApiResult<JobDetail>>((yes) => { resolve = yes }))
    const life = lifecycle()
    const actions = createJobActions(mutate, vi.fn(), life)
    const pending = actions.run(31, 'cancel')
    await actions.run(31, 'cancel'); expect(mutate).toHaveBeenCalledTimes(1)
    expect(actions.getSnapshot()).toEqual({ kind: 'pending', id: 31, action: 'cancel' })
    expect(life.success).not.toHaveBeenCalled()
    resolve({ kind: 'ok', data: job('job-cancel-requested.json') }); await pending
    expect(life.success).toHaveBeenCalledExactlyOnceWith(job('job-cancel-requested.json'), 'cancel')
    expect(actions.getSnapshot()).toMatchObject({ kind: 'message', cancelSubmitted: true })
    expect(life.resume).toHaveBeenCalledExactlyOnceWith(false)
  })
  it.each(['job_terminal', 'job_active', 'retry_not_allowed'] as const)('409 %s triggers one explicit reread and explanation', async (reason) => {
    const life = lifecycle()
    const actions = createJobActions(async () => ({ kind: 'error', status: 409, reason }), vi.fn(), life)
    await actions.run(31, reason === 'job_terminal' ? 'cancel' : 'retry')
    expect(life.success).not.toHaveBeenCalled(); expect(life.resume).toHaveBeenCalledExactlyOnceWith(true)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'message', error: { reason }, message: expect.stringContaining('актуальное состояние') })
  })
  it('refreshes CSRF but never repeats the mutation automatically', async () => {
    const mutate = vi.fn().mockResolvedValue({ kind: 'error', reason: 'csrf_failed', status: 403 })
    const refresh = vi.fn().mockResolvedValue({ kind: 'ok', data: csrf() })
    const actions = createJobActions(mutate, refresh, lifecycle())
    await actions.run(31, 'cancel')
    expect(mutate).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1)
    expect(actions.getSnapshot()).toMatchObject({ message: expect.stringContaining('попробуйте снова') })
  })
  it('does not announce completion after a network failure and forces reconciliation', async () => {
    const life = lifecycle()
    const actions = createJobActions(async () => ({ kind: 'error', reason: 'timeout' }), vi.fn(), life)
    await actions.run(31, 'retry')
    expect(life.success).not.toHaveBeenCalled(); expect(life.resume).toHaveBeenCalledWith(true)
    expect(actions.getSnapshot()).toMatchObject({ message: expect.stringContaining('могло выполниться') })
  })
  it('returns the new retry job rather than overwriting the old one', async () => {
    const next = { ...job(), id: 32, retry_of: 31, status: 'queued' as const }
    const life = lifecycle()
    const actions = createJobActions(async () => ({ kind: 'ok', data: next }), vi.fn(), life)
    await actions.run(31, 'retry')
    expect(life.success).toHaveBeenCalledExactlyOnceWith(next, 'retry')
  })
  it('cancels a mutation on navigation and ignores its late server reply', async () => {
    let resolve!: (value: LocalApiResult<JobDetail>) => void
    let signal!: AbortSignal
    const life = lifecycle()
    const actions = createJobActions((_id, _action, current) => { signal = current; return new Promise((yes) => { resolve = yes }) }, vi.fn(), life)
    const pending = actions.run(31, 'cancel'); actions.dispose(); expect(signal.aborted).toBe(true)
    resolve({ kind: 'ok', data: job('job-cancel-requested.json') }); await pending
    expect(life.success).not.toHaveBeenCalled(); expect(life.resume).not.toHaveBeenCalled()
  })
  it('pauses polling before cancel and prevents an older read from restoring running', async () => {
    let resolve!: (value: LocalApiResult<JobDetail>) => void
    const request = createPollingRequest<JobDetail>(() => new Promise((yes) => { resolve = yes }), isActive, acceptJob)
    request.start()
    const server = job('job-cancel-requested.json')
    const actions = createJobActions(async () => ({ kind: 'ok', data: server }), vi.fn(), {
      pause: request.pause, resume: request.resume, success: request.setData,
    })
    await actions.run(31, 'cancel'); resolve({ kind: 'ok', data: job() }); await flush()
    expect(request.getSnapshot()).toMatchObject({ data: server })
    actions.dispose(); request.dispose()
  })
})
