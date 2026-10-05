import { describe, expect, it } from 'vitest'
import { errorFixtures } from '../../api/product-merges-test-support'
import { detectText, errorText, factValue, plural } from './labels'
import { lookupOf, marksOf } from './marks'
import {
  apiStatus, canConfirm, confirmInput, conflictOptions, initialSelection, mergedHint, missingResolutions, normalizeSelection,
  pendingTargets, refusedFields, selectName, selectResolution, selectTarget,
} from './state'
import { detected, failed, group, groups, success } from './test-support'

const pizza = group('group-pending.json') // records 5 (kept), 26, 43
const milk = group('group-pending-conflict.json') // records 2 (kept), 14, 36; generic differs at 2 and 36

describe('choice on the group screen', () => {
  it('starts from the kept record of the group, the unchanged name and no decisions', () => {
    expect(initialSelection(pizza)).toEqual({ target: 5, resolutions: {} })
    expect(confirmInput(pizza, initialSelection(pizza))).toEqual({ version: 1, target_product_id: 5 })
    expect(canConfirm(pizza, initialSelection(pizza))).toBe(true)
  })
  it('sends another kept record and the name only after an explicit choice', () => {
    const kept = selectTarget(initialSelection(pizza), 43)
    expect(confirmInput(pizza, kept)).toEqual({ version: 1, target_product_id: 43 })
    expect(confirmInput(pizza, selectName(kept, 26))).toEqual({ version: 1, target_product_id: 43, name_product_id: 26 })
    expect(confirmInput(pizza, selectName(selectName(kept, 26), undefined))).toEqual({ version: 1, target_product_id: 43 })
  })
  it('treats the kept record as the unchanged name when it is also the chosen name source', () => {
    expect(selectName(initialSelection(pizza), 5)).toEqual({ target: 5, resolutions: {} })
    const named = selectName(initialSelection(pizza), 26)
    expect(selectTarget(named, 26)).toEqual({ target: 26, resolutions: {} })
    expect(selectTarget(named, 43)).toEqual({ target: 43, name: 26, resolutions: {} })
  })
  it('keeps confirmation unavailable until every disputed field has a value', () => {
    const start = initialSelection(milk)
    expect(missingResolutions(milk, start)).toEqual(['generic'])
    expect(canConfirm(milk, start)).toBe(false)
    const chosen = selectResolution(start, 'generic', 2)
    expect(missingResolutions(milk, chosen)).toEqual([])
    expect(canConfirm(milk, chosen)).toBe(true)
    expect(confirmInput(milk, chosen)).toEqual({ version: 1, target_product_id: 2, resolutions: { generic: 2 } })
  })
  it('offers only records with a value of the disputed field', () => {
    expect(conflictOptions(milk, milk.conflicts[0]).map((member) => member.product_id)).toEqual([2, 36])
  })
  it('always sends the version of the last read group', () => {
    expect(confirmInput({ ...pizza, version: 7 }, initialSelection(pizza)).version).toBe(7)
  })
  it('drops choices which the freshly read group no longer offers', () => {
    const stale = { target: 43, name: 26, resolutions: { generic: 26, brand: 5 } }
    const excluded = { ...pizza, members: pizza.members.map((member) => member.product_id === 43 ? { ...member, state: 'excluded' as const } : member) }
    expect(normalizeSelection(excluded, stale)).toEqual({ target: 5, name: 26, resolutions: {} })
    expect(normalizeSelection(milk, { target: 2, resolutions: { generic: 14 } })).toEqual({ target: 2, resolutions: {} })
    expect(confirmInput(milk, { target: 2, name: 99, resolutions: { generic: 36, model: 2 } }))
      .toEqual({ version: 1, target_product_id: 2, resolutions: { generic: 36 } })
  })
  it('never confirms a finished group', () => {
    expect(canConfirm(group('group-confirmed.json'), initialSelection(group('group-confirmed.json')))).toBe(false)
    expect(canConfirm(group('group-cancelled.json'), initialSelection(group('group-cancelled.json')))).toBe(false)
  })
  it('names refused fields from the error, without the resolutions prefix', () => {
    expect(refusedFields({ kind: 'error', reason: 'merge_conflict', status: 409, fields: errorFixtures['error-merge-conflict.json'].fields })).toEqual(['generic'])
    expect(refusedFields({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['resolutions.generic', 'target_product_id'] })).toEqual(['generic', 'target_product_id'])
    expect(refusedFields({ kind: 'error', reason: 'merge_busy', status: 409, fields: ['generic'] })).toEqual([])
    expect(refusedFields(undefined)).toEqual([])
  })
  it('maps the list filter to the API: pending by default, no status for all', () => {
    expect(apiStatus({ page: 1 })).toBe('pending')
    expect(apiStatus({ status: 'confirmed', page: 1 })).toBe('confirmed')
    expect(apiStatus({ status: 'all', page: 1 })).toBeUndefined()
  })
})

describe('marks of the catalog and the product card', () => {
  const list = groups().results // 3 cancelled (18, 38), 2 pending (5 kept; 26, 43), 1 confirmed (2 kept; 14, 36 deleted)
  it('marks only kept products of pending groups', () => {
    expect([...pendingTargets(list)]).toEqual([[5, { groupId: 2, records: 3 }]])
    expect(marksOf(success(groups())).get(5)).toEqual({ groupId: 2, records: 3 })
  })
  it('counts active records only', () => {
    const excluded = list.map((item) => item.id === 2 ? { ...item, members: item.members.map((member) => member.product_id === 43 ? { ...member, state: 'excluded' as const } : member) } : item)
    expect(pendingTargets(excluded).get(5)).toEqual({ groupId: 2, records: 2 })
  })
  it('shows no marks while loading and after any refusal', () => {
    expect(marksOf({ kind: 'loading' }).size).toBe(0)
    expect(marksOf(failed('permission_denied', 403)).size).toBe(0)
    expect(marksOf(failed('network')).size).toBe(0)
    expect(lookupOf(failed('permission_denied', 403), 26)).toEqual({ checking: false })
    expect(lookupOf({ kind: 'loading' }, 26)).toEqual({ checking: true })
  })
  it('leads an absorbed id to its pending group and a deleted id to the kept product', () => {
    expect(mergedHint(list, 26)).toEqual({ groupId: 2, pending: true, target: { id: 5, name: 'Steinhof.PizzaSpezial' } })
    expect(mergedHint(list, 36)).toEqual({ groupId: 1, pending: false, target: { id: 2, name: 'GQ EgSB H-Milch 1,5%' } })
    expect(lookupOf(success(groups()), 14).hint).toMatchObject({ pending: false, target: { id: 2 } })
  })
  it('gives no hint for kept, cancelled, excluded and unknown records', () => {
    expect(mergedHint(list, 5)).toBeUndefined()
    expect(mergedHint(list, 2)).toBeUndefined()
    expect(mergedHint(list, 38)).toBeUndefined()
    expect(mergedHint(list, 999)).toBeUndefined()
    const excluded = list.map((item) => ({ ...item, members: item.members.map((member) => member.product_id === 26 ? { ...member, state: 'excluded' as const } : member) }))
    expect(mergedHint(excluded, 26)).toBeUndefined()
    expect(lookupOf(success(groups()), 5)).toEqual({ checking: false, mark: { groupId: 2, records: 3 } })
  })
})

describe('texts', () => {
  it('declines Russian counters', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((count) => plural(count, 'написание', 'написания', 'написаний')))
      .toEqual(['написание', 'написания', 'написаний', 'написаний', 'написание', 'написания', 'написаний', 'написаний'])
  })
  it('reports the search result from the server counters', () => {
    expect(detectText(detected())).toBe('Создано групп: 3.')
    expect(detectText({ created: 0, extended: 0, group_ids: [] })).toBe('Новых дублей не найдено.')
    expect(detectText({ created: 0, extended: 2, group_ids: [4, 6] })).toBe('Дополнено групп: 2.')
    expect(detectText({ created: 1, extended: 1, group_ids: [4, 8] })).toBe('Создано групп: 1, дополнено групп: 1.')
  })
  it('shows facts of a record, the service generic product as unclassified', () => {
    expect(factValue(milk.members[0], 'generic')).toBe('Молоко')
    expect(factValue(milk.members[1], 'generic')).toBe('Не разобрано')
    expect(factValue(milk.members[0], 'brand')).toBe('Не указано')
    expect(factValue(groups().results[0].members[0], 'package')).toBe('10 шт')
  })
  it('translates every merge refusal locally', () => {
    expect(errorText({ kind: 'error', reason: 'permission_denied', status: 403 })).toContain('Локальный API выключен')
    expect(errorText({ kind: 'error', reason: 'merge_changed', status: 409 }, true)).toContain('Состав группы изменился')
    expect(errorText({ kind: 'error', reason: 'merge_busy', status: 409 }, true)).toContain('Каталог сейчас изменяется')
    expect(errorText({ kind: 'error', reason: 'merge_resolved', status: 409 }, true)).toContain('Слияние уже завершено')
    expect(errorText({ kind: 'error', reason: 'merge_conflict', status: 409, fields: ['generic'] }, true)).toContain('Выберите значение')
    expect(errorText({ kind: 'error', reason: 'merge_conflict', status: 409, fields: ['name'] }, true)).toContain('по названию')
    expect(errorText({ kind: 'error', reason: 'merge_conflict', status: 409, fields: ['gtin'] }, true)).toContain('GTIN')
    expect(errorText({ kind: 'error', reason: 'timeout' }, true)).toContain('могло выполниться')
    expect(errorText({ kind: 'error', reason: 'timeout' })).not.toContain('могло выполниться')
  })
})
