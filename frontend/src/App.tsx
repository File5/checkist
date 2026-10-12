import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { buildRoute, Link, navigate, useNavigation } from './navigation'
import type { NavigationSnapshot, Route } from './navigation'
import HealthPage from './pages/HealthPage'
import CatalogPage from './features/catalog/CatalogPage'
import CategoryPage from './features/catalog/CategoryPage'
import ProductPage from './features/product/ProductPage'
import RequestState from './components/RequestState'
import { UploadPage, JobsPage, JobPage } from './features/recognition'
import { ReceiptsPage, ReceiptPage } from './features/receipts'
import { ExpensePage } from './features/expense'
import { CategorySpendsPage, DashboardPage, LimitsPage } from './features/dashboard'
import { MergesPage, MergePage } from './features/merges'
import { ClassificationPage } from './features/classification'
import { SpendingPage, ReceiptsStatsPage, TrendsPage } from './features/stats'
import { LoginPage, AccountPage } from './features/auth'
import { ExportPage } from './features/export'
import { pageKey, shellView, watchSession } from './features/auth/auth-state'
import type { ShellView } from './features/auth/auth-state'
import { moderatorOnlyText } from './features/auth/labels'
import { canModerate, loadSession, useSession } from './session'
import { menuKey, useCurrentItemInView } from './menu-view'
import MainMenu from './menu/MainMenu'
import { backTarget } from './menu/back-target'
import { ThemeToggle } from './theme'
import OfflineBanner from './offline/OfflineBanner'
import { usePendingSync } from './offline/pending-store'
import emblem from './assets/brand/emblem-96.webp'
import emblem2x from './assets/brand/emblem-192.webp'

function pageTitle(route: Route) {
  switch (route.kind) {
    case 'dashboard': return 'Главная'
    case 'limits': return 'Лимиты на месяц'
    case 'category-spends': return 'Траты категории'
    case 'catalog': return 'Каталог продуктов'
    case 'category': return 'Категория продуктов'
    case 'product': return 'Товар и история цен'
    case 'spending': return 'Траты за период'
    case 'receipts-stats': return 'Средний чек'
    case 'trends': return 'Динамика'
    case 'health': return 'Состояние сервисов'
    case 'receipts': return 'Траты'
    case 'upload': return 'Загрузка фото чеков'
    case 'expense-new': return 'Добавить трату'
    case 'expense-edit': return 'Изменить трату'
    case 'receipt': return 'Чек'
    case 'jobs': return 'Обработка'
    case 'job': return 'Задание обработки'
    case 'merges': return 'Дубли товаров'
    case 'merge': return 'Группа дублей'
    case 'classification': return 'Категории товаров'
    case 'login': return 'Вход'
    case 'account': return 'Аккаунт'
    case 'export': return 'Выгрузка'
    case 'invalid-query': return 'Некорректная ссылка'
    case 'not-found': return 'Страница не найдена'
  }
}

/** The heading of what the shell shows in place of the page. */
function shellTitle(view: ShellView, route: Route) {
  switch (view) {
    case 'page': return pageTitle(route)
    case 'loading': return 'Проверяем вход'
    case 'error': return 'Вход не проверен'
    case 'login': return 'Вход'
    case 'forbidden': return 'Раздел модератора каталога'
    case 'not-found': return 'Страница не найдена'
  }
}

const notFound = <RequestState kind="empty" message="Такой страницы нет. Перейдите в каталог продуктов." action={<><p className="request-state-note">Наружное наблюдение результатов не дало.</p><Link className="action-link" to="/catalog">В каталог</Link></>} />

function pageContent({ route, returnTo }: NavigationSnapshot, username: string) {
  switch (route.kind) {
    case 'dashboard': return <DashboardPage month={route.month} />
    case 'limits': return <LimitsPage />
    case 'category-spends': return <CategorySpendsPage key={route.categoryId} categoryId={route.categoryId} month={route.month} />
    case 'catalog': return <CatalogPage query={route.query} />
    case 'category': return <CategoryPage categoryId={route.categoryId} query={route.query} />
    case 'product': return <ProductPage productId={route.productId} query={route.query} returnTo={returnTo} />
    case 'spending': return <SpendingPage query={route.query} />
    case 'receipts-stats': return <ReceiptsStatsPage query={route.query} />
    case 'trends': return <TrendsPage query={route.query} />
    case 'health': return <HealthPage />
    case 'receipts': return <ReceiptsPage query={route.query} />
    case 'upload': return <UploadPage />
    case 'expense-new': return <ExpensePage key="new" />
    case 'expense-edit': return <ExpensePage key={route.receiptId} receiptId={route.receiptId} />
    case 'receipt': return <ReceiptPage receiptId={route.receiptId} returnTo={returnTo} />
    case 'jobs': return <JobsPage query={route.query} />
    case 'job': return <JobPage jobId={route.jobId} returnTo={returnTo} />
    case 'merges': return <MergesPage query={route.query} />
    case 'merge': return <MergePage groupId={route.groupId} returnTo={returnTo} />
    case 'classification': return <ClassificationPage query={route.query} />
    // A signed-in person has nothing to do at the sign-in address: the shell sends them to «Главная».
    case 'login': return null
    case 'account': return <AccountPage username={username} />
    case 'export': return <ExportPage query={route.query} />
    case 'invalid-query': return <RequestState kind="empty" message="В адресе указаны некорректные фильтры или номер страницы. Сбросьте параметры и попробуйте снова." action={<Link className="action-link" to={route.resetTo} replace>Сбросить параметры</Link>} />
    case 'not-found': return notFound
  }
}

export default function App() {
  const navigation = useNavigation()
  const { route } = navigation
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLElement>(null)
  const previousNavigation = useRef<NavigationSnapshot | undefined>(undefined)
  const previousShell = useRef<string | undefined>(undefined)
  const pathname = navigation.href.split(/[?#]/)[0]
  const session = useSession()
  const view = shellView(session, route)
  const title = shellTitle(view, route)
  // The health page lives through every change of the session; any other page belongs to one person.
  const contentKey = route.kind === 'health' ? 'health' : pageKey(session)
  const shell = `${view}:${contentKey}`

  useEffect(() => watchSession(loadSession, document), [])
  // Spends kept on the phone without network belong to one person and are sent when the network is back.
  usePendingSync(session.kind === 'user' ? session.user.username : null)

  useLayoutEffect(() => {
    const previous = previousNavigation.current
    const sameShell = previousShell.current === shell
    previousNavigation.current = navigation
    previousShell.current = shell
    // The sign-in, its result and a page created again for another person start at the heading too.
    if (previous?.href.split(/[?#]/)[0] === pathname && sameShell) return
    heading.current?.focus()
    if (!previous?.returnTo
      || !['product', 'receipt', 'job', 'merge'].includes(previous.route.kind)
      || (route.kind !== 'catalog' && route.kind !== 'category' && route.kind !== 'receipts' && route.kind !== 'jobs' && route.kind !== 'merges' && route.kind !== 'classification')
      || buildRoute(route) !== previous.returnTo || !content.current) return

    // The list loads asynchronously. Restore the selected link only while the
    // user has left focus on the transition heading; never interrupt their work.
    const detailHref = previous.route.kind === 'product'
      ? buildRoute({ kind: 'product', productId: previous.route.productId, query: { page: 1 } })
      : previous.route.kind === 'receipt' || previous.route.kind === 'job' || previous.route.kind === 'merge' ? buildRoute(previous.route) : undefined
    const stop = () => {
      observer.disconnect()
      document.removeEventListener('focusin', cancelOnFocus)
    }
    const cancelOnFocus = () => { if (document.activeElement !== heading.current) stop() }
    const restore = () => {
      if (document.activeElement !== heading.current) { stop(); return }
      const link = content.current?.querySelector<HTMLAnchorElement>(`a[href="${detailHref}"]`)
      if (link) { stop(); link.focus() }
    }
    const observer = new MutationObserver(restore)
    observer.observe(content.current, { childList: true, subtree: true })
    document.addEventListener('focusin', cancelOnFocus)
    restore()
    return stop
  }, [navigation, pathname, route, shell])

  const leaveLogin = route.kind === 'login' && view === 'page'
  useLayoutEffect(() => {
    // After the sign-in on /login, and for a signed-in person who opens it: «Главная», without a history entry.
    if (leaveLogin) navigate('/', { replace: true })
  }, [leaveLogin])

  useEffect(() => {
    document.title = `Чекист — ${title}`
  }, [title])

  const mainNavigation = useCurrentItemInView(menuKey(view, session, route))
  // «Назад» of the phone's top bar on a nested page: to the list the person came from, or to the parent list.
  const back = view === 'page' ? backTarget(navigation) : undefined

  const mergesActive = route.kind === 'merges' || route.kind === 'merge'
  const classificationActive = route.kind === 'classification'
  const catalogActive = route.kind === 'catalog' || route.kind === 'category' || route.kind === 'product' || mergesActive || classificationActive
  const statsActive = route.kind === 'spending' || route.kind === 'receipts-stats' || route.kind === 'trends'
  const signedIn = session.kind === 'user'
  const username = signedIn ? session.user.username : ''
  // The sign-in is drawn alone, on the address the person opened: no header, menu or footer.
  // Its form is labelled by this heading, so the heading goes into the screen, which draws its own <main>.
  if (view === 'login') return (
    <LoginPage expired={session.kind === 'guest' && session.expired}
      heading={<h1 id="page-heading" ref={heading} tabIndex={-1}>{title}</h1>} />
  )
  let body: ReactNode
  switch (view) {
    case 'page': body = <Fragment key={contentKey}>{pageContent(navigation, username)}</Fragment>; break
    case 'loading': body = <RequestState kind="loading" message="Проверяем вход…" />; break
    case 'error': body = <RequestState kind="error" message="Не удалось проверить вход. Проверьте соединение и повторите попытку." onRetry={() => { void loadSession() }} />; break
    case 'forbidden': body = <RequestState kind="empty" message={`${moderatorOnlyText}.`} action={<Link className="action-link" to="/catalog">В каталог</Link>} />; break
    case 'not-found': body = notFound; break
  }
  return (
    <>
      <a className="skip-link" href="#page-heading">К содержимому</a>
      <OfflineBanner />
      <header className="brand-bar">
        <Link className="brand" to="/" aria-label="Чекист — главная">
          <img className="brand-mark" src={emblem} srcSet={`${emblem} 1x, ${emblem2x} 2x`} width={44} height={44} alt="" />
          <span>Чекист</span>
        </Link>
        <div className="brand-actions">
          <ThemeToggle placement="header" />
        </div>
        <MainMenu session={session} route={route} menuRef={mainNavigation} />
      </header>

      <div className="page">
        <main id="main" ref={content}>
          {/* On a phone this row is the compact top bar pinned to the top of the window. */}
          <div className="intro">
            {back && <Link className="ck-back" to={back.to} aria-label={back.label}>
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M15.4 5 8.4 12l7 7 1.4-1.4L11.2 12l5.6-5.6z" /></svg>
            </Link>}
            <h1 id="page-heading" ref={heading} tabIndex={-1}>{title}</h1>
          </div>
          {route.kind === 'health' && <p className="intro-note intro-note-after">Сводка о состоянии служб.</p>}
          {catalogActive && view === 'page' && canModerate(session) && <nav className="main-navigation section-navigation" aria-label="Раздел каталога">
            <Link to="/catalog" aria-current={mergesActive || classificationActive ? undefined : 'page'}>Товары</Link>
            <Link to="/catalog/merges" aria-current={mergesActive ? 'page' : undefined}>Дубли</Link>
            <Link to="/catalog/classification" aria-current={classificationActive ? 'page' : undefined}>Категории</Link>
          </nav>}
          {statsActive && view === 'page' && <nav className="main-navigation section-navigation" aria-label="Раздел статистики">
            <Link to="/stats" aria-current={route.kind === 'spending' ? 'page' : undefined}>Траты</Link>
            <Link to="/stats/receipts" aria-current={route.kind === 'receipts-stats' ? 'page' : undefined}>Средний чек</Link>
            <Link to="/stats/trends" aria-current={route.kind === 'trends' ? 'page' : undefined}>Динамика</Link>
          </nav>}
          {body}
        </main>
        {/* The old jokes of the brand stay, quietly, in the footer line. */}
        <footer>Чекист — семейный бюджет · Доверяй, но проверяй чек</footer>
      </div>
    </>
  )
}
