import type { Route } from '../navigation'
import type { Session } from '../session'
import { personName } from '../lib/people'
import type { IconName } from '../components/Icon'

export type MenuItem = {
  key: string
  to: string
  /** The visible text of the link. */
  label: string
  current: boolean
  /** The account link: its name tells whose account it is, and the link has its own class. */
  account?: boolean
  /** The picture above the word in the bottom bar of a phone and before it in the list behind «Ещё». */
  icon: IconName
}

export type Menu = {
  /** Links that are always in sight: direct children of the menu. */
  primary: MenuItem[]
  /** Links that the phone keeps behind «Ещё»; empty when everything fits. */
  more: MenuItem[]
  /** The round «＋» of the phone's bar («Снять чек», «Добавить трату»), after the second link: a signed-in person only. */
  add: boolean
}

/** The bottom bar of a phone holds four things besides «＋»: four links, or three links and «Ещё». */
export const BAR_SLOTS = 4
/** How many links stand before «＋» in the bar: «Главная · Траты · ＋ · Статистика · Ещё». */
export const ADD_AFTER = 2

/** The month dashboard at '/', its limits at '/budget/limits' and the spends of one of its categories. */
const homeKinds: Route['kind'][] = ['dashboard', 'limits', 'category-spends']
const catalogKinds: Route['kind'][] = ['catalog', 'category', 'product', 'merges', 'merge', 'classification']
const receiptKinds: Route['kind'][] = ['receipts', 'upload', 'expense-new', 'expense-edit', 'receipt']
const statsKinds: Route['kind'][] = ['spending', 'receipts-stats', 'trends']
const jobKinds: Route['kind'][] = ['jobs', 'job']

/** Every item of the main menu, in the order of the header. */
function allItems(session: Session, route: Route): MenuItem[] {
  const health: MenuItem = { key: 'health', to: '/health', label: 'Состояние сервисов', current: route.kind === 'health', icon: 'health' }
  // A guest sees the shell only on the health page: everywhere else the sign-in replaces it.
  if (session.kind === 'guest') return [health, { key: 'login', to: '/login', label: 'Войти', current: false, icon: 'login' }]
  // While «Я» is being read, and when it could not be read, nothing is known about the person.
  if (session.kind !== 'user') return [health]
  const items: MenuItem[] = [
    { key: 'home', to: '/', label: 'Главная', current: homeKinds.includes(route.kind), icon: 'home' },
    { key: 'receipts', to: '/receipts', label: 'Траты', current: receiptKinds.includes(route.kind), icon: 'list' },
    { key: 'stats', to: '/stats', label: 'Статистика', current: statsKinds.includes(route.kind), icon: 'stats' },
    { key: 'recurring', to: '/recurring', label: 'Платежи', current: route.kind === 'recurring', icon: 'repeat' },
    { key: 'catalog', to: '/catalog', label: 'Каталог', current: catalogKinds.includes(route.kind), icon: 'catalog' },
    { key: 'stores', to: '/stores', label: 'Магазины', current: route.kind === 'stores', icon: 'store' },
    { key: 'jobs', to: '/recognition/jobs', label: 'Обработка', current: jobKinds.includes(route.kind), icon: 'jobs' },
    { key: 'export', to: '/export', label: 'Выгрузка', current: route.kind === 'export', icon: 'export' },
    health,
  ]
  if (session.mode === 'accounts') {
    items.push({ key: 'family', to: '/family', label: 'Семья', current: route.kind === 'family', icon: 'family' })
    items.push({ key: 'account', to: '/account', label: personName(session.user.username, session.user.display_name), current: route.kind === 'account', account: true, icon: 'account' })
  }
  return items
}

/** The main menu of the shell and how a phone splits it. The order of the links never changes:
 * `primary` followed by `more` is the menu of the header.
 */
export function menuItems(session: Session, route: Route): Menu {
  const items = allItems(session, route)
  const add = session.kind === 'user'
  if (items.length <= BAR_SLOTS) return { primary: items, more: [], add }
  return { primary: items.slice(0, BAR_SLOTS - 1), more: items.slice(BAR_SLOTS - 1), add }
}
