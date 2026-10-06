import { describe, expect, it } from 'vitest'
import { isMergeDetectResult, isMergeGroup, isMergeGroupBrief, isMergeLine, isMergeMember, isMergeMemberBrief } from './product-merges-schema'
import { errorFixtures, mergeFixture, mergeFixtureNames } from './product-merges-test-support'
import { page } from './schema'
import type { MergeGroup, MergeGroupBrief, MergeLine } from './product-merges-types'
import type { Page } from './types'

const schemas: Record<string, (value: unknown) => boolean> = {
  'groups.json': page(isMergeGroupBrief), 'lines.json': page(isMergeLine), 'detect.json': isMergeDetectResult,
  'group-pending.json': isMergeGroup, 'group-pending-conflict.json': isMergeGroup,
  'group-confirmed.json': isMergeGroup, 'group-cancelled.json': isMergeGroup,
}
const group = (name = 'group-pending-conflict.json') => structuredClone(mergeFixture(name)) as MergeGroup
const brief = () => structuredClone((mergeFixture('groups.json') as Page<MergeGroupBrief>).results.find((item) => item.status === 'pending')!)
const line = () => structuredClone((mergeFixture('lines.json') as Page<MergeLine>).results[0])

describe('public product-merge contract fixtures', () => {
  it('covers every JSON supplied by backend, including future additions', () => {
    expect([...Object.keys(schemas), ...Object.keys(errorFixtures)].sort()).toEqual(mergeFixtureNames())
  })
  it.each(Object.entries(schemas))('validates %s and requires every root field', (name, validate) => {
    const body = mergeFixture(name) as Record<string, unknown>
    expect(validate(body)).toBe(true)
    for (const key of Object.keys(body)) {
      const missing = { ...body }
      delete missing[key]
      expect(validate(missing), `${name} missing ${key}`).toBe(false)
    }
    for (const invalid of [null, [], true, 'body', 1, {}]) expect(validate(invalid)).toBe(false)
  })
  it('requires every documented field of a member, a brief group, a purchase and its store', () => {
    const cases: [string, () => Record<string, unknown>, (value: unknown) => boolean][] = [
      ['member', () => group().members[0], isMergeMember], ['brief member', () => brief().members[0], isMergeMemberBrief],
      ['brief group', brief, isMergeGroupBrief], ['purchase', line, isMergeLine],
    ]
    for (const [name, make, validate] of cases) {
      expect(validate(make()), name).toBe(true)
      for (const key of Object.keys(make())) {
        const missing = make()
        delete missing[key]
        expect(validate(missing), `${name} missing ${key}`).toBe(false)
      }
    }
    for (const key of ['id', 'name', 'city', 'country'] as const) {
      const purchase: Record<string, unknown> = line()
      delete (purchase.store as Record<string, unknown>)[key]
      expect(isMergeLine(purchase), `store missing ${key}`).toBe(false)
    }
    for (const key of ['can_confirm', 'can_cancel', 'can_exclude'] as const) {
      const body: Record<string, unknown> = group()
      delete (body.actions as Record<string, unknown>)[key]
      expect(isMergeGroup(body), `actions missing ${key}`).toBe(false)
    }
  })
  it('keeps the two projections apart: the list has no aliases/conflicts, the group has no has_conflicts', () => {
    const listed = brief()
    expect(isMergeGroup(listed)).toBe(false)
    expect('aliases' in listed.members[0]).toBe(false)
    expect(isMergeGroupBrief(group())).toBe(false)
    expect(isMergeMember(listed.members[0])).toBe(false)
  })
  it('accepts a cancelled group and an excluded record without journal data', () => {
    const cancelled = group('group-cancelled.json')
    expect(cancelled.members.every((member) => member.lines_count === 0 && member.first_purchased_on === null && member.aliases.length === 0)).toBe(true)
    const pending = group('group-pending.json')
    Object.assign(pending.members[2], { state: 'excluded', lines_count: 0, first_purchased_on: null, last_purchased_on: null, aliases: [] })
    expect(isMergeGroup(pending)).toBe(true)
  })

  const member = (patch: object) => (body: MergeGroup) => { Object.assign(body.members[1], patch) }
  it.each<[string, (body: MergeGroup) => void]>([
    ['unknown status', (body) => { Object.assign(body, { status: 'merged' }) }],
    ['string id', (body) => { Object.assign(body, { id: '1' }) }],
    ['unsafe id', (body) => { body.id = Number.MAX_SAFE_INTEGER + 1 }],
    ['zero version', (body) => { body.version = 0 }],
    ['local datetime', (body) => { body.created_at = '2026-10-06 10:00:00' }],
    ['pending with resolved_at', (body) => { body.resolved_at = body.created_at }],
    ['target outside members', (body) => { body.target_product_id = 999 }],
    ['negative lines_count', (body) => { body.lines_count = -1 }],
    ['more new lines than lines', (body) => { body.new_lines_count = body.lines_count + 1 }],
    ['non-boolean action', (body) => { Object.assign(body.actions, { can_confirm: 1 }) }],
    ['members not an array', (body) => { Object.assign(body, { members: {} }) }],
    ['members out of order', (body) => { body.members.reverse() }],
    ['duplicate member', (body) => { body.members[1].product_id = body.members[0].product_id }],
    ['unknown role', member({ role: 'kept' })], ['unknown state', member({ state: 'removed' })],
    ['exists as number', member({ exists: 1 })], ['null name', member({ name: null })],
    ['brand as string', member({ brand: 'Demo' })], ['null model', member({ model: null })], ['numeric gtin', member({ gtin: 4000000000000 })],
    ['float package quantity', member({ package: { quantity: 10, unit: 'pcs' } })],
    ['short package quantity', member({ package: { quantity: '10.0', unit: 'pcs' } })],
    ['unknown package unit', member({ package: { quantity: '10.000', unit: 'box' } })],
    ['missing generic', member({ generic: null })], ['unknown base unit', member({ generic: { id: 91, name: 'Не разобрано', base_unit: 'g' } })],
    ['classified as string', member({ classified: 'false' })], ['impossible date', member({ first_purchased_on: '2026-02-30' })],
    ['dates without journal lines', member({ lines_count: 0 })], ['journal lines without dates', member({ first_purchased_on: null, last_purchased_on: null })],
    ['first purchase after last', member({ first_purchased_on: '2026-12-31' })],
    ['alias without code', member({ aliases: [{ store_name: 'Demomarkt', raw_name: 'X' }] })], ['aliases as null', member({ aliases: null })],
    ['unknown conflict field', (body) => { Object.assign(body.conflicts[0], { field: 'name' }) }],
    ['conflict of one record', (body) => { body.conflicts[0].product_ids = [2] }],
    ['conflict of a foreign product', (body) => { body.conflicts[0].product_ids = [2, 999] }],
    ['repeated conflict record', (body) => { body.conflicts[0].product_ids = [2, 2] }],
    ['repeated conflict field', (body) => { body.conflicts.push(structuredClone(body.conflicts[0])) }],
    ['conflict ids as strings', (body) => { Object.assign(body.conflicts[0], { product_ids: ['2', '36'] }) }],
  ])('rejects a group with %s', (_name, change) => {
    const body = group()
    change(body)
    expect(isMergeGroup(body)).toBe(false)
  })
  it.each<[string, string, (body: MergeGroup) => void]>([
    ['confirmed', 'group-confirmed.json', (body) => { body.resolved_at = null }],
    ['confirmed', 'group-confirmed.json', (body) => { body.actions.can_cancel = true }],
    ['confirmed', 'group-confirmed.json', (body) => { body.new_lines_count = 1 }],
    ['confirmed', 'group-confirmed.json', (body) => { body.conflicts = [{ field: 'generic', product_ids: [2, 36] }] }],
    ['cancelled', 'group-cancelled.json', (body) => { body.actions.can_exclude = true }],
  ])('rejects a %s group that still looks open (%#)', (_status, name, change) => {
    const body = group(name)
    expect(isMergeGroup(body)).toBe(true)
    change(body)
    expect(isMergeGroup(body)).toBe(false)
  })
  it('rejects a resolved brief group flagged with conflicts and a non-boolean flag', () => {
    const resolved = structuredClone((mergeFixture('groups.json') as Page<MergeGroupBrief>).results.find((item) => item.status !== 'pending')!)
    expect(isMergeGroupBrief(resolved)).toBe(true)
    expect(isMergeGroupBrief({ ...resolved, has_conflicts: true })).toBe(false)
    expect(isMergeGroupBrief({ ...brief(), has_conflicts: 1 })).toBe(false)
  })
  it.each<[string, object]>([
    ['float quantity', { quantity: 1 }], ['two-digit price', { unit_price: '3.49' }], ['four-digit amount', { amount: '3.4900' }],
    ['numeric discount', { discount_amount: 0 }], ['unknown unit', { unit: 'box' }], ['long currency', { currency: 'EURO' }],
    ['zero origin', { origin_product_id: 0 }], ['string origin', { origin_product_id: '43' }], ['negative position', { position: -1 }],
    ['datetime as date', { purchased_on: '2026-06-09T00:00:00Z' }], ['null name', { name: null }], ['zero line id', { line_id: 0 }],
    ['long country', { store: { id: 51, name: 'Demomarkt', city: 'Musterstadt', country: 'DEU' } }],
  ])('rejects a purchase with %s', (_name, patch) => {
    expect(isMergeLine({ ...line(), ...patch })).toBe(false)
  })
  it('accepts a purchase that came after the merge and decimals only as exact strings', () => {
    expect(isMergeLine({ ...line(), origin_product_id: null })).toBe(true)
  })
  it.each<[string, object]>([
    ['negative created', { created: -1 }], ['string extended', { extended: '0' }], ['ids as object', { group_ids: {} }],
    ['zero id', { group_ids: [0] }], ['repeated id', { group_ids: [1, 1] }],
  ])('rejects a detect answer with %s', (_name, patch) => {
    expect(isMergeDetectResult({ ...(mergeFixture('detect.json') as object), ...patch })).toBe(false)
  })
  it('accepts an unchanged catalog answer of detect', () => {
    expect(isMergeDetectResult({ created: 0, extended: 0, group_ids: [] })).toBe(true)
  })
  it('rejects a page whose arithmetic or items are wrong', () => {
    const body = mergeFixture('groups.json') as Page<MergeGroupBrief>
    expect(page(isMergeGroupBrief)({ ...body, pages: 2 })).toBe(false)
    expect(page(isMergeGroupBrief)({ ...body, page_size: 201 })).toBe(false)
    expect(page(isMergeGroupBrief)({ ...body, results: [group()] })).toBe(false)
    expect(page(isMergeLine)({ ...(mergeFixture('lines.json') as object), results: [{}] })).toBe(false)
  })
})
