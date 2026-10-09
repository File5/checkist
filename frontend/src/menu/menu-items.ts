import type { Route } from '../navigation'
import type { Session } from '../session'

export type MenuItem = {
  key: string
  to: string
  /** The visible text of the link. */
  label: string
  current: boolean
  /** The account link: its name tells whose account it is, and the link has its own class. */
  account?: boolean
}

export type Menu = {
  /** Links that are always in sight: direct children of the menu. */
  primary: MenuItem[]
  /** Links that the phone keeps behind «Ещё»; empty when everything fits. */
  more: MenuItem[]
}

/** The bottom bar of a phone holds four things: four links, or three links and «Ещё». */
export const BAR_SLOTS = 4

const catalogKinds: Route['kind'][] = ['catalog', 'category', 'product', 'merges', 'merge', 'classification']
const receiptKinds: Route['kind'][] = ['receipts', 'upload', 'receipt']
const statsKinds: Route['kind'][] = ['spending', 'receipts-stats']
const jobKinds: Route['kind'][] = ['jobs', 'job']

/** Every item of the main menu, in the order of the header. */
function allItems(session: Session, route: Route): MenuItem[] {
  const health: MenuItem = { key: 'health', to: '/health', label: 'Состояние сервисов', current: route.kind === 'health' }
  // A guest sees the shell only on the health page: everywhere else the sign-in replaces it.
  if (session.kind === 'guest') return [health, { key: 'login', to: '/login', label: 'Войти', current: false }]
  // While «Я» is being read, and when it could not be read, nothing is known about the person.
  if (session.kind !== 'user') return [health]
  const items: MenuItem[] = [
    { key: 'catalog', to: '/catalog', label: 'Каталог', current: catalogKinds.includes(route.kind) },
    { key: 'receipts', to: '/receipts', label: 'Чеки', current: receiptKinds.includes(route.kind) },
    { key: 'stats', to: '/stats', label: 'Статистика', current: statsKinds.includes(route.kind) },
    { key: 'jobs', to: '/recognition/jobs', label: 'Обработка', current: jobKinds.includes(route.kind) },
    health,
  ]
  if (session.mode === 'accounts') {
    items.push({ key: 'account', to: '/account', label: session.user.username, current: route.kind === 'account', account: true })
  }
  return items
}

/** The main menu of the shell and how a phone splits it. The order of the links never changes:
 * `primary` followed by `more` is the menu of the header.
 */
export function menuItems(session: Session, route: Route): Menu {
  const items = allItems(session, route)
  if (items.length <= BAR_SLOTS) return { primary: items, more: [] }
  return { primary: items.slice(0, BAR_SLOTS - 1), more: items.slice(BAR_SLOTS - 1) }
}
