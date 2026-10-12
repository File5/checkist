import { describe, expect, it } from 'vitest'
import type { Route } from '../navigation'
import { backTarget, headerAction, isFocusRoute } from './back-target'

const at = (route: Route, returnTo?: string) => backTarget({ route, returnTo })

describe('«назад» of the phone top bar (pure, no browser)', () => {
  it('leads a nested page to its parent list without a remembered list', () => {
    expect(at({ kind: 'receipt', receiptId: 7 })).toEqual({ to: '/receipts', label: 'Назад к тратам' })
    expect(at({ kind: 'job', jobId: 9 })).toEqual({ to: '/recognition/jobs', label: 'Назад к заданиям' })
    expect(at({ kind: 'product', productId: 5, query: { page: 1 } })).toEqual({ to: '/catalog', label: 'Назад в каталог' })
    expect(at({ kind: 'category', categoryId: 3, query: { page: 1 } })).toEqual({ to: '/catalog', label: 'Назад в каталог' })
    expect(at({ kind: 'merge', groupId: 2 })).toEqual({ to: '/catalog/merges', label: 'Назад к дублям' })
    expect(at({ kind: 'limits' })).toEqual({ to: '/', label: 'Назад на главную' })
    // The form that changes a spend goes back to the spend itself.
    expect(at({ kind: 'expense-edit', receiptId: 12 })).toEqual({ to: '/receipts/12', label: 'Назад к трате' })
  })

  it('returns to the very list the person came from, with its filters and page', () => {
    expect(at({ kind: 'receipt', receiptId: 7 }, '/?month=2026-09')).toEqual({ to: '/?month=2026-09', label: 'Назад на главную' })
    expect(at({ kind: 'receipt', receiptId: 7 }, '/receipts?store=4&page=2')).toEqual({ to: '/receipts?store=4&page=2', label: 'Назад к тратам' })
    expect(at({ kind: 'receipt', receiptId: 7 }, '/recognition/jobs/3')).toEqual({ to: '/recognition/jobs/3', label: 'Назад к заданию' })
    expect(at({ kind: 'product', productId: 5, query: { page: 1 } }, '/catalog/categories/4?page=3')).toEqual({ to: '/catalog/categories/4?page=3', label: 'Назад к категории' })
    expect(at({ kind: 'product', productId: 5, query: { page: 1 } }, '/receipts/7')).toEqual({ to: '/receipts/7', label: 'Назад к трате' })
    expect(at({ kind: 'product', productId: 5, query: { page: 1 } }, '/catalog/classification?status=all')).toEqual({ to: '/catalog/classification?status=all', label: 'Назад к категориям товаров' })
    expect(at({ kind: 'merge', groupId: 2 }, '/catalog/merges?page=2')).toEqual({ to: '/catalog/merges?page=2', label: 'Назад к дублям' })
    expect(at({ kind: 'job', jobId: 9 }, '/receipts/7')).toEqual({ to: '/receipts/7', label: 'Назад к трате' })
  })

  it('has no way back on a page of a section itself', () => {
    const top: Route[] = [
      { kind: 'dashboard' }, { kind: 'receipts', query: { page: 1 } }, { kind: 'catalog', query: { page: 1 } }, { kind: 'jobs', query: { page: 1 } },
      { kind: 'spending', query: {} }, { kind: 'health' }, { kind: 'account' }, { kind: 'upload' }, { kind: 'expense-new' },
      { kind: 'merges', query: { page: 1 } }, { kind: 'classification', query: { page: 1 } }, { kind: 'not-found', path: '/x' },
    ]
    for (const route of top) expect(at(route, '/receipts'), route.kind).toBeUndefined()
  })
})

describe('the round control of the header row (pure, no browser)', () => {
  it('closes a focus screen with «✕»: a changed spend to its receipt, a new one to where the person came from', () => {
    expect(headerAction({ route: { kind: 'expense-edit', receiptId: 12 } })).toEqual({ kind: 'close', to: '/receipts/12', label: 'Закрыть' })
    expect(headerAction({ route: { kind: 'expense-new' } }, '/receipts?page=2')).toEqual({ kind: 'close', to: '/receipts?page=2', label: 'Закрыть' })
    // Opened directly: «Главная».
    expect(headerAction({ route: { kind: 'expense-new' } })).toEqual({ kind: 'close', to: '/', label: 'Закрыть' })
    expect(isFocusRoute({ kind: 'expense-new' })).toBe(true)
    expect(isFocusRoute({ kind: 'expense-edit', receiptId: 3 })).toBe(true)
    expect(isFocusRoute({ kind: 'receipts', query: { page: 1 } })).toBe(false)
  })

  it('goes back from any other nested page and has nothing on a page of a section', () => {
    expect(headerAction({ route: { kind: 'receipt', receiptId: 7 } }, '/stats')).toEqual({ kind: 'back', to: '/receipts', label: 'Назад к тратам' })
    expect(headerAction({ route: { kind: 'dashboard' } }, '/receipts')).toBeUndefined()
  })
})
