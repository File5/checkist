import { describe, expect, it } from 'vitest'
import {
  isClassification, isClassificationConfirmMany, isClassificationRun, isClassificationRunRequest, isClassificationState,
} from './product-classifications-schema'
import { classificationFixture, classificationFixtureNames, errorFixtures, requestFixtures } from './product-classifications-test-support'
import { page } from './schema'
import type { Classification, ClassificationConfirmMany, ClassificationRun, ClassificationRunRequest, ClassificationState } from './product-classifications-types'
import type { Page } from './types'

const schemas: Record<string, (value: unknown) => boolean> = {
  'classifications.json': page(isClassification), 'runs.json': page(isClassificationRun),
  'classification-pending.json': isClassification, 'classification-confirmed.json': isClassification,
  'classification-confirmed-other.json': isClassification, 'classification-rejected.json': isClassification,
  'classification-superseded.json': isClassification, 'confirm-many.json': isClassificationConfirmMany,
  'run.json': isClassificationRun, 'run-failed.json': isClassificationRun,
  'run-created.json': isClassificationRunRequest, 'run-existing.json': isClassificationRunRequest, 'run-nothing.json': isClassificationRunRequest,
  'status.json': isClassificationState, 'status-empty.json': isClassificationState, 'status-queued.json': isClassificationState,
  'status-running.json': isClassificationState,
}
const record = (name = 'classification-pending.json') => structuredClone(classificationFixture(name)) as Classification
const run = (name = 'run.json') => structuredClone(classificationFixture(name)) as ClassificationRun
const state = (name = 'status-queued.json') => structuredClone(classificationFixture(name)) as ClassificationState
const requireEvery = (name: string, make: () => unknown, validate: (value: unknown) => boolean) => {
  expect(validate(make()), name).toBe(true)
  for (const key of Object.keys(make() as object)) {
    const missing = make() as Record<string, unknown>
    delete missing[key]
    expect(validate(missing), `${name} missing ${key}`).toBe(false)
  }
}

describe('public product-classification contract fixtures', () => {
  it('covers all 35 JSON files supplied by backend, including future additions', () => {
    const covered = [...Object.keys(schemas), ...Object.keys(errorFixtures), ...requestFixtures].sort()
    expect(covered).toEqual(classificationFixtureNames())
    expect(covered).toHaveLength(35)
  })
  it.each(Object.entries(schemas))('validates %s and requires every root field', (name, validate) => {
    requireEvery(name, () => structuredClone(classificationFixture(name)), validate)
    for (const invalid of [null, [], true, 'body', 1, {}]) expect(validate(invalid)).toBe(false)
  })
  it('requires every documented field of the nested objects of a record', () => {
    const nested: [string, (body: Classification) => object][] = [
      ['product', (body) => body.product], ['product.package', (body) => body.product.package!], ['product.generic', (body) => body.product.generic!],
      ['product.aliases.0', (body) => body.product.aliases[0]], ['previous_generic', (body) => body.previous_generic],
      ['suggested', (body) => body.suggested], ['suggested.generic', (body) => body.suggested.generic],
      ['suggested.category', (body) => body.suggested.category!], ['suggested.category.path.0', (body) => body.suggested.category!.path[0]],
      ['source', (body) => body.source], ['actions', (body) => body.actions],
    ]
    for (const [name, pick] of nested) {
      for (const key of Object.keys(pick(record()))) {
        const body = record()
        delete (pick(body) as Record<string, unknown>)[key]
        expect(isClassification(body), `${name} missing ${key}`).toBe(false)
      }
    }
    const decided = record('classification-confirmed.json')
    for (const key of Object.keys(decided.final_generic!)) {
      const body = record('classification-confirmed.json')
      delete (body.final_generic as unknown as Record<string, unknown>)[key]
      expect(isClassification(body), `final_generic missing ${key}`).toBe(false)
    }
  })
  it('requires every documented field of a run, its progress, its error and the worker', () => {
    for (const key of Object.keys(run().progress)) {
      const body = run()
      delete (body.progress as Record<string, unknown>)[key]
      expect(isClassificationRun(body), `progress missing ${key}`).toBe(false)
    }
    for (const key of ['code', 'message']) {
      const body = run('run-failed.json')
      delete (body.error as unknown as Record<string, unknown>)[key]
      expect(isClassificationRun(body), `error missing ${key}`).toBe(false)
    }
    for (const key of ['available', 'last_seen_at']) {
      const body = state()
      delete (body.executor as unknown as Record<string, unknown>)[key]
      expect(isClassificationState(body), `executor missing ${key}`).toBe(false)
    }
  })
  it('accepts the times of the real server, with fractions of a second', () => {
    const body = record('classification-confirmed.json')
    body.created_at = '2026-10-06T21:13:45.465650Z'
    body.resolved_at = '2026-10-06T21:14:02.1Z'
    expect(isClassification(body)).toBe(true)
    const queued = run('run-failed.json')
    Object.assign(queued, { created_at: '2026-10-06T21:13:45.465650Z', started_at: '2026-10-06T21:13:46.000001Z', finished_at: '2026-10-06T21:13:47.5Z' })
    expect(isClassificationRun(queued)).toBe(true)
    expect(isClassificationState({ ...state(), executor: { available: true, state: 'idle', last_seen_at: '2026-10-06T21:13:45.465650Z' } })).toBe(true)
  })
  it('accepts the documented nulls: no category, a deleted source run, a removed product and a removed suggestion', () => {
    const damaged = record()
    damaged.suggested.category = null
    Object.assign(damaged.source, { run_id: null, trigger: null })
    expect(isClassification(damaged)).toBe(true)
    const removed = record('classification-superseded.json')
    Object.assign(removed, { resolution: 'product_removed', final_generic: null })
    Object.assign(removed.product, { exists: false, generic: null, aliases: [], brand: null, package: null })
    expect(isClassification(removed)).toBe(true)
    const rejected = record('classification-rejected.json')
    expect(rejected.suggested.generic).toMatchObject({ exists: false, is_new: false })
    expect(isClassification(rejected)).toBe(true)
    const waiting = record()
    Object.assign(waiting.actions, { can_confirm: false, can_choose: false, can_reject: false })
    waiting.product.generic = { id: 92, name: 'Молоко', base_unit: 'l' }
    waiting.product.merge_group_id = 7
    expect(isClassification(waiting)).toBe(true)
  })
  it('keeps an unknown worker state as unknown and an unknown run error code as text', () => {
    const body = state()
    Object.assign(body.executor, { state: 'sleeping' })
    expect(isClassificationState(body)).toBe(true)
    expect(body.executor.state).toBe('unknown')
    const failed = run('run-failed.json')
    failed.error!.code = 'something_new'
    expect(isClassificationRun(failed)).toBe(true)
  })

  it.each<[string, (body: Classification) => void]>([
    ['unknown status', (body) => { Object.assign(body, { status: 'done' }) }],
    ['string id', (body) => { Object.assign(body, { id: '3' }) }],
    ['unsafe id', (body) => { body.id = Number.MAX_SAFE_INTEGER + 1 }],
    ['zero version', (body) => { body.version = 0 }],
    ['local datetime', (body) => { body.created_at = '2026-10-06 10:00:00' }],
    ['pending with a resolution', (body) => { body.resolution = 'confirmed' }],
    ['pending with resolved_at', (body) => { body.resolved_at = body.created_at }],
    ['pending with a final generic product', (body) => { body.final_generic = body.previous_generic }],
    ['non-boolean action', (body) => { Object.assign(body.actions, { can_confirm: 1 }) }],
    ['product without a generic product', (body) => { body.product.generic = null }],
    ['exists as number', (body) => { Object.assign(body.product, { exists: 1 }) }],
    ['null name', (body) => { Object.assign(body.product, { name: null }) }],
    ['brand as string', (body) => { Object.assign(body.product, { brand: 'Demowurst' }) }],
    ['float package quantity', (body) => { Object.assign(body.product, { package: { quantity: 200, unit: 'g' } }) }],
    ['unknown package unit', (body) => { Object.assign(body.product, { package: { quantity: '200.000', unit: 'box' } }) }],
    ['aliases as null', (body) => { Object.assign(body.product, { aliases: null }) }],
    ['zero merge group', (body) => { body.product.merge_group_id = 0 }],
    ['unknown base unit', (body) => { Object.assign(body.suggested.generic, { base_unit: 'g' }) }],
    ['is_new as string', (body) => { Object.assign(body.suggested.generic, { is_new: 'true' }) }],
    ['negative pending_count', (body) => { body.suggested.pending_count = -1 }],
    ['category outside its own path', (body) => { body.suggested.category!.id = 999 }],
    ['category with an empty path', (body) => { body.suggested.category!.path = [] }],
    ['path item without is_new', (body) => { Object.assign(body.suggested.category!, { path: [{ id: 4, name: 'Мясные продукты' }] }) }],
    ['numeric provider', (body) => { Object.assign(body.source, { provider: 1 }) }],
    ['run_id as string', (body) => { Object.assign(body.source, { run_id: '1' }) }],
    ['previous generic as null', (body) => { Object.assign(body, { previous_generic: null }) }],
  ])('rejects a record with %s', (_name, change) => {
    const body = record()
    change(body)
    expect(isClassification(body)).toBe(false)
  })
  it.each<[string, string, (body: Classification) => void]>([
    ['confirmed', 'classification-confirmed.json', (body) => { body.resolved_at = null }],
    ['confirmed', 'classification-confirmed.json', (body) => { body.resolution = null }],
    ['confirmed', 'classification-confirmed.json', (body) => { body.resolution = 'rejected' }],
    ['confirmed', 'classification-confirmed-other.json', (body) => { body.actions.can_reject = true }],
    ['rejected', 'classification-rejected.json', (body) => { body.resolution = 'merged' }],
    ['superseded', 'classification-superseded.json', (body) => { body.resolution = 'other' }],
    ['superseded', 'classification-superseded.json', (body) => { Object.assign(body, { resolution: 'gone' }) }],
    ['removed product', 'classification-superseded.json', (body) => { body.product.exists = false }],
  ])('rejects a %s record with an inconsistent lifecycle (%#)', (_status, name, change) => {
    const body = record(name)
    expect(isClassification(body)).toBe(true)
    change(body)
    expect(isClassification(body)).toBe(false)
  })
  it.each<[string, string, (body: ClassificationRun) => void]>([
    ['unknown status', 'run.json', (body) => { Object.assign(body, { status: 'done' }) }],
    ['succeeded with an error', 'run.json', (body) => { body.error = { code: 'timeout', message: 'private' } }],
    ['failed without an error', 'run-failed.json', (body) => { body.error = null }],
    ['negative remaining', 'run.json', (body) => { body.remaining = -1 }],
    ['null remaining', 'run.json', (body) => { Object.assign(body, { remaining: null }) }],
    ['string progress', 'run.json', (body) => { Object.assign(body.progress, { applied: '8' }) }],
    ['queued and started', 'run.json', (body) => { body.status = 'queued' }],
    ['date as a calendar day', 'run.json', (body) => { body.created_at = '2026-10-06' }],
    ['numeric trigger', 'run.json', (body) => { Object.assign(body, { trigger: 1 }) }],
  ])('rejects a run with %s', (_name, fixture, change) => {
    const body = run(fixture)
    change(body)
    expect(isClassificationRun(body)).toBe(false)
  })
  it('rejects a state, a run request and a mass confirmation that contradict themselves', () => {
    expect(isClassificationState({ ...state(), pending_count: -1 })).toBe(false)
    expect(isClassificationState({ ...state(), auto_suggest: 0 })).toBe(false)
    expect(isClassificationState({ ...state(), run: {} })).toBe(false)
    expect(isClassificationState({ ...state(), executor: { available: 'no', state: 'absent', last_seen_at: null } })).toBe(false)
    const created = classificationFixture('run-created.json') as ClassificationRunRequest
    expect(isClassificationRunRequest({ ...created, run: null })).toBe(false)
    expect(isClassificationRunRequest({ ...created, created: 'yes' })).toBe(false)
    const many = classificationFixture('confirm-many.json') as ClassificationConfirmMany
    expect(isClassificationConfirmMany({ ...many, confirmed: 1 })).toBe(false)
    expect(isClassificationConfirmMany({ ...many, results: [...many.results].reverse() })).toBe(false)
    expect(isClassificationConfirmMany({ confirmed: 1, results: [record()] })).toBe(false)
    expect(isClassificationConfirmMany({ confirmed: 0, results: [] })).toBe(true)
  })
  it('rejects a page whose arithmetic or items are wrong', () => {
    const body = classificationFixture('classifications.json') as Page<Classification>
    expect(page(isClassification)({ ...body, pages: 2 })).toBe(false)
    expect(page(isClassification)({ ...body, page_size: 201 })).toBe(false)
    expect(page(isClassification)({ ...body, results: [run()] })).toBe(false)
    expect(page(isClassificationRun)({ ...(classificationFixture('runs.json') as object), results: [{}] })).toBe(false)
    expect(page(isClassification)({ ...body, count: 9, page_size: 200, results: body.results })).toBe(true)
  })
})
