import { parseRoute } from '../navigation'
import type { NavigationSnapshot, Route } from '../navigation'

/** The «назад» of the phone's top bar: where it leads and its name for a screen reader. */
export type BackTarget = { to: string; label: string }

/** The round control of the header row: «назад» before the heading, or «✕» after it on a focus screen. */
export type HeaderAction = BackTarget & { kind: 'back' | 'close' }

/** A new or changed spend: a screen of one task, with «✕» instead of «назад» and without the bottom bar of a phone. */
export function isFocusRoute(route: Route): boolean {
  return route.kind === 'expense-new' || route.kind === 'expense-edit' || route.kind === 'income-edit'
}

/** The name of the way back by the kind of the page it leads to. */
const backLabels: Partial<Record<Route['kind'], string>> = {
  dashboard: 'Назад на главную',
  receipts: 'Назад к тратам',
  receipt: 'Назад к трате',
  jobs: 'Назад к заданиям',
  job: 'Назад к заданию',
  catalog: 'Назад в каталог',
  category: 'Назад к категории',
  merges: 'Назад к дублям',
  classification: 'Назад к категориям товаров',
  'statement-new': 'Назад к выпискам',
  incomes: 'Назад к доходам',
  goals: 'Назад к целям',
}

const labelOf = (href: string) => backLabels[parseRoute(new URL(href, 'http://checkist.invalid')).kind] ?? 'Назад'

const target = (to: string): BackTarget => ({ to, label: labelOf(to) })

/**
 * The way back from a nested page: to the list the person came from (`returnTo`, the same address with its
 * filters and page), otherwise to the parent list of the page. A page of a section itself has none.
 */
export function backTarget({ route, returnTo }: Pick<NavigationSnapshot, 'route' | 'returnTo'>): BackTarget | undefined {
  switch (route.kind) {
    case 'receipt': return target(returnTo ?? '/receipts')
    case 'expense-edit': return target(`/receipts/${route.receiptId}`)
    case 'job': return target(returnTo ?? '/recognition/jobs')
    case 'product': return target(returnTo ?? '/catalog')
    case 'category': return target('/catalog')
    case 'merge': return target(returnTo ?? '/catalog/merges')
    case 'limits': return target('/')
    case 'statement': return target(returnTo ?? '/statements/new')
    case 'goal': return target('/goals')
    // Back to «Главная» of the same month; from a deeper category — still «Главная», the screen links its parents itself.
    case 'category-spends': return target(returnTo ?? (route.month ? `/?month=${route.month}` : '/'))
    default: return undefined
  }
}

/**
 * The control of the header row. A focus screen is closed by «✕»: a changed spend back to its receipt, a new one to
 * the page of the app the person came from (`from`), otherwise to «Главная». Any other nested page goes back by
 * «назад» (`backTarget`); a page of a section has none.
 */
export function headerAction(navigation: Pick<NavigationSnapshot, 'route' | 'returnTo'>, from?: string): HeaderAction | undefined {
  const { route } = navigation
  if (route.kind === 'expense-new') return { kind: 'close', to: from ?? '/', label: 'Закрыть' }
  if (route.kind === 'expense-edit') return { kind: 'close', to: `/receipts/${route.receiptId}`, label: 'Закрыть' }
  if (route.kind === 'income-edit') return { kind: 'close', to: from ?? '/incomes', label: 'Закрыть' }
  const back = backTarget(navigation)
  return back && { kind: 'back', ...back }
}
