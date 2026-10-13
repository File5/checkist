import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { Route } from './navigation'
import { inFlightCount, subscribe } from './api/activity'

/* The screens of the shell, each in its own part of the build (feature/split-skeletons, 2026-10-13).
 *
 * The first open of the app and the first open after a deploy download the shell only: header, menu, session, the
 * sign-in. The script of the screen of the opened address starts at once (`preloadRoute` from App, in parallel with
 * the check of the session), the scripts of the other screens are warmed when the first screen is shown and the
 * network is quiet (`warmScreens`), so a later move never waits for code.
 *
 * A screen here keeps the module of its former static import (`./features/dashboard`, not a file inside it): the tests
 * replace these modules by `vi.mock`, and the module of a feature is one part of the build with its own helpers.
 * A new screen of the shell goes into this file and into `routeScreens`, never into a static import of App.tsx
 * (screens.test.tsx keeps App.tsx so). The styles are not split: every stylesheet is in styles.ts.
 */

/** The script of a screen did not arrive (no network, or a deploy removed the old parts): App shows «Повторить». */
export class ScreenLoadError extends Error {
  constructor(screen: string, cause: unknown) {
    super(`The script of the screen «${screen}» did not load`, { cause })
    this.name = 'ScreenLoadError'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the signature of React.lazy itself
type AnyComponent = ComponentType<any>
export type Screen<C extends AnyComponent> = LazyExoticComponent<C> & {
  /** Starts the script of the screen; resolves with the component. A failed attempt is forgotten: the next one fetches again. */
  preload: () => Promise<C>
  /** The script is here: the screen renders at once, never through its fallback. */
  isLoaded: () => boolean
}
type Part = Pick<Screen<AnyComponent>, 'preload' | 'isLoaded'>

const all: (Part & { name: string })[] = []

/** A thenable that calls back at once: React.lazy takes it as resolved and renders the screen without a fallback. */
function settled<T>(value: T): Promise<T> {
  const thenable = { then: (resolve: (value: T) => unknown) => { resolve(value); return thenable } }
  return thenable as unknown as Promise<T>
}

/** One import of a module for all of its screens (a module of a feature holds several). A failed import is forgotten. */
function part<M>(load: () => Promise<M>): () => Promise<M> {
  let pending: Promise<M> | undefined
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined
      throw error
    })
    return pending
  }
}

function screen<M, C extends AnyComponent>(name: string, module: () => Promise<M>, pick: (module: M) => C): Screen<C> {
  let loaded: C | undefined
  let pending: Promise<C> | undefined
  const preload = () => {
    pending ??= module().then((value) => {
      const component = pick(value)
      if (typeof component !== 'function' && (typeof component !== 'object' || component === null)) throw new TypeError(`${name} is not a component`)
      loaded = component
      return component
    }).catch((cause: unknown) => {
      pending = undefined
      throw new ScreenLoadError(name, cause)
    })
    return pending
  }
  // Already loaded (warmed, or the screen of the first address): rendered at once, the same element type either way.
  const component = lazy(() => loaded ? settled({ default: loaded }) : preload().then((value) => ({ default: value })))
  const isLoaded = () => loaded !== undefined
  all.push({ name, preload, isLoaded })
  return Object.assign(component, { preload, isLoaded })
}

const healthPagePart = part(() => import('./pages/HealthPage'))
const catalogPagePart = part(() => import('./features/catalog/CatalogPage'))
const categoryPagePart = part(() => import('./features/catalog/CategoryPage'))
const productPagePart = part(() => import('./features/product/ProductPage'))
const recognitionPart = part(() => import('./features/recognition'))
const receiptsPart = part(() => import('./features/receipts'))
const expensePart = part(() => import('./features/expense'))
const dashboardPart = part(() => import('./features/dashboard'))
const mergesPart = part(() => import('./features/merges'))
const classificationPart = part(() => import('./features/classification'))
const statsPart = part(() => import('./features/stats'))
const accountPagePart = part(() => import('./features/auth/AccountPage'))
const exportPart = part(() => import('./features/export'))
const recurringPart = part(() => import('./features/recurring'))
const incomesPart = part(() => import('./features/incomes'))
const storesPart = part(() => import('./features/stores'))
const familyPart = part(() => import('./features/family'))
const statementsPart = part(() => import('./features/statements'))
const insightsPart = part(() => import('./features/insights'))
const goalsPart = part(() => import('./features/goals'))
const morePart = part(() => import('./features/more/MorePage'))

export const HealthPage = screen('HealthPage', healthPagePart, (module) => module.default)
export const CatalogPage = screen('CatalogPage', catalogPagePart, (module) => module.default)
export const CategoryPage = screen('CategoryPage', categoryPagePart, (module) => module.default)
export const ProductPage = screen('ProductPage', productPagePart, (module) => module.default)
export const UploadPage = screen('UploadPage', recognitionPart, (module) => module.UploadPage)
export const JobsPage = screen('JobsPage', recognitionPart, (module) => module.JobsPage)
export const JobPage = screen('JobPage', recognitionPart, (module) => module.JobPage)
export const ReceiptsPage = screen('ReceiptsPage', receiptsPart, (module) => module.ReceiptsPage)
export const ReceiptPage = screen('ReceiptPage', receiptsPart, (module) => module.ReceiptPage)
export const ExpensePage = screen('ExpensePage', expensePart, (module) => module.ExpensePage)
export const DashboardPage = screen('DashboardPage', dashboardPart, (module) => module.DashboardPage)
export const LimitsPage = screen('LimitsPage', dashboardPart, (module) => module.LimitsPage)
export const CategorySpendsPage = screen('CategorySpendsPage', dashboardPart, (module) => module.CategorySpendsPage)
export const MergesPage = screen('MergesPage', mergesPart, (module) => module.MergesPage)
export const MergePage = screen('MergePage', mergesPart, (module) => module.MergePage)
export const ClassificationPage = screen('ClassificationPage', classificationPart, (module) => module.ClassificationPage)
export const SpendingPage = screen('SpendingPage', statsPart, (module) => module.SpendingPage)
export const ReceiptsStatsPage = screen('ReceiptsStatsPage', statsPart, (module) => module.ReceiptsStatsPage)
export const TrendsPage = screen('TrendsPage', statsPart, (module) => module.TrendsPage)
export const IncomesStatsPage = screen('IncomesStatsPage', statsPart, (module) => module.IncomesStatsPage)
export const AccountPage = screen('AccountPage', accountPagePart, (module) => module.default)
export const ExportPage = screen('ExportPage', exportPart, (module) => module.ExportPage)
export const RecurringPage = screen('RecurringPage', recurringPart, (module) => module.RecurringPage)
export const IncomesPage = screen('IncomesPage', incomesPart, (module) => module.IncomesPage)
export const StoresPage = screen('StoresPage', storesPart, (module) => module.StoresPage)
export const FamilyPage = screen('FamilyPage', familyPart, (module) => module.FamilyPage)
export const NewFamilyPage = screen('NewFamilyPage', familyPart, (module) => module.NewFamilyPage)
export const NewFamilySignedIn = screen('NewFamilySignedIn', familyPart, (module) => module.NewFamilySignedIn)
export const UploadStatementPage = screen('UploadStatementPage', statementsPart, (module) => module.UploadStatementPage)
export const StatementPage = screen('StatementPage', statementsPart, (module) => module.StatementPage)
export const StatementRulesPage = screen('StatementRulesPage', statementsPart, (module) => module.StatementRulesPage)
export const ReviewPage = screen('ReviewPage', insightsPart, (module) => module.ReviewPage)
export const AskPage = screen('AskPage', insightsPart, (module) => module.AskPage)
export const GoalsPage = screen('GoalsPage', goalsPart, (module) => module.GoalsPage)
export const GoalPage = screen('GoalPage', goalsPart, (module) => module.GoalPage)
export const MorePage = screen('MorePage', morePart, (module) => module.default)

/** The screen App renders for a route of a signed-in person; none — the shell draws the route itself. */
export const routeScreens: Record<Route['kind'], Part | undefined> = {
  dashboard: DashboardPage, limits: LimitsPage, 'category-spends': CategorySpendsPage,
  catalog: CatalogPage, category: CategoryPage, product: ProductPage,
  spending: SpendingPage, 'receipts-stats': ReceiptsStatsPage, trends: TrendsPage, 'stats-incomes': IncomesStatsPage,
  health: HealthPage, receipts: ReceiptsPage, upload: UploadPage, receipt: ReceiptPage,
  'expense-new': ExpensePage, 'expense-edit': ExpensePage, 'income-edit': ExpensePage, incomes: IncomesPage,
  jobs: JobsPage, job: JobPage, merges: MergesPage, merge: MergePage, classification: ClassificationPage,
  account: AccountPage, export: ExportPage, family: FamilyPage, recurring: RecurringPage, stores: StoresPage,
  'family-new': NewFamilySignedIn, 'statement-new': UploadStatementPage, statement: StatementPage, 'statement-rules': StatementRulesPage,
  review: ReviewPage, ask: AskPage, goals: GoalsPage, goal: GoalPage, more: MorePage,
  login: undefined, 'invalid-query': undefined, 'not-found': undefined,
}

/** Starts the script of the screen of a route; a failure is shown by the screen itself when it renders. */
export function preloadRoute(kind: Route['kind']): Promise<unknown> {
  return (routeScreens[kind]?.preload() ?? Promise.resolve()).catch(() => undefined)
}

/** Every screen, settled: the tests render the shell with the real markup of its screens (renderToStaticMarkup
 * never waits for a lazy part). A screen whose module a test replaced without it simply stays unloaded. */
export async function preloadScreens(): Promise<void> {
  await Promise.allSettled(all.map((item) => item.preload()))
}

/** At most this long the warm-up waits for the network of the first screen to become quiet. */
export const WARM_QUIET_LIMIT_MS = 5000

let warming = false

/** Once per page: after `first` (the script of the shown screen) and the end of its requests, on an idle moment,
 * every other screen is loaded too. Not with «Экономия трафика»: there each screen comes when it is opened. */
export function warmScreens(first: Promise<unknown>): void {
  if (warming || typeof window === 'undefined') return
  warming = true
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  if (connection?.saveData) return
  const idle = (callback: () => void) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(callback, { timeout: 2000 })
    else window.setTimeout(callback, 200)
  }
  const warm = () => idle(() => { for (const item of all) void item.preload().catch(() => undefined) })
  void first.catch(() => undefined).then(() => {
    if (inFlightCount() === 0) { warm(); return }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      stop()
      window.clearTimeout(limit)
      warm()
    }
    const stop = subscribe((count) => { if (count === 0) finish() })
    const limit = window.setTimeout(finish, WARM_QUIET_LIMIT_MS)
  })
}
