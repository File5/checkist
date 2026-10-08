import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { buildRoute, Link, useNavigation } from './navigation'
import type { NavigationSnapshot, Route } from './navigation'
import HealthPage from './pages/HealthPage'
import CatalogPage from './features/catalog/CatalogPage'
import CategoryPage from './features/catalog/CategoryPage'
import ProductPage from './features/product/ProductPage'
import RequestState from './components/RequestState'
import { UploadPage, JobsPage, JobPage } from './features/recognition'
import { ReceiptsPage, ReceiptPage } from './features/receipts'
import { MergesPage, MergePage } from './features/merges'
import { ClassificationPage } from './features/classification'
import { SpendingPage, ReceiptsStatsPage } from './features/stats'
import { LoginPage, AccountPage } from './features/auth'
import { pageKey, shellView, watchSession } from './features/auth/auth-state'
import type { ShellView } from './features/auth/auth-state'
import { moderatorOnlyText } from './features/auth/labels'
import { canModerate, loadSession, useSession } from './session'

function pageTitle(route: Route) {
  switch (route.kind) {
    case 'catalog': return 'Каталог продуктов'
    case 'category': return 'Категория продуктов'
    case 'product': return 'Товар и история цен'
    case 'spending': return 'Траты за период'
    case 'receipts-stats': return 'Средний чек'
    case 'health': return 'Состояние сервисов'
    case 'receipts': return 'Чеки'
    case 'upload': return 'Загрузка фото чеков'
    case 'receipt': return 'Чек'
    case 'jobs': return 'Обработка'
    case 'job': return 'Задание обработки'
    case 'merges': return 'Дубли товаров'
    case 'merge': return 'Группа дублей'
    case 'classification': return 'Категории товаров'
    case 'account': return 'Аккаунт'
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

const notFound = <RequestState kind="empty" message="Такой страницы нет. Перейдите в каталог продуктов." action={<Link className="action-link" to="/catalog">В каталог</Link>} />

function pageContent({ route, returnTo }: NavigationSnapshot, username: string) {
  switch (route.kind) {
    case 'catalog': return <CatalogPage query={route.query} />
    case 'category': return <CategoryPage categoryId={route.categoryId} query={route.query} />
    case 'product': return <ProductPage productId={route.productId} query={route.query} returnTo={returnTo} />
    case 'spending': return <SpendingPage query={route.query} />
    case 'receipts-stats': return <ReceiptsStatsPage query={route.query} />
    case 'health': return <HealthPage />
    case 'receipts': return <ReceiptsPage query={route.query} />
    case 'upload': return <UploadPage />
    case 'receipt': return <ReceiptPage receiptId={route.receiptId} returnTo={returnTo} />
    case 'jobs': return <JobsPage query={route.query} />
    case 'job': return <JobPage jobId={route.jobId} returnTo={returnTo} />
    case 'merges': return <MergesPage query={route.query} />
    case 'merge': return <MergePage groupId={route.groupId} returnTo={returnTo} />
    case 'classification': return <ClassificationPage query={route.query} />
    case 'account': return <AccountPage username={username} />
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

  useEffect(() => {
    document.title = `Checkist — ${title}`
  }, [title])

  const mergesActive = route.kind === 'merges' || route.kind === 'merge'
  const classificationActive = route.kind === 'classification'
  const catalogActive = route.kind === 'catalog' || route.kind === 'category' || route.kind === 'product' || mergesActive || classificationActive
  const statsActive = route.kind === 'spending' || route.kind === 'receipts-stats'
  const signedIn = session.kind === 'user'
  const username = signedIn ? session.user.username : ''
  let body: ReactNode
  switch (view) {
    case 'page': body = <Fragment key={contentKey}>{pageContent(navigation, username)}</Fragment>; break
    case 'loading': body = <RequestState kind="loading" message="Проверяем вход…" />; break
    case 'error': body = <RequestState kind="error" message="Не удалось проверить вход. Проверьте соединение и повторите попытку." onRetry={() => { void loadSession() }} />; break
    case 'login': body = <LoginPage expired={session.kind === 'guest' && session.expired} />; break
    case 'forbidden': body = <RequestState kind="empty" message={`${moderatorOnlyText}.`} action={<Link className="action-link" to="/catalog">В каталог</Link>} />; break
    case 'not-found': body = notFound; break
  }
  return (
    <div className="page">
      <a className="skip-link" href="#page-heading">К содержимому</a>
      <header className="brand-bar">
        <Link className="brand" to="/catalog" aria-label="Checkist — каталог">
          <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M9 5h14v23l-3-2-4 2-4-2-3 2V5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="m12 12 3 3 5-5M12 20h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Checkist</span>
        </Link>
        <nav className="main-navigation" aria-label="Основная навигация">
          {signedIn && <>
            <Link to="/catalog" aria-current={catalogActive ? 'page' : undefined}>Каталог</Link>
            <Link to="/receipts" aria-current={['receipts', 'upload', 'receipt'].includes(route.kind) ? 'page' : undefined}>Чеки</Link>
            <Link to="/stats" aria-current={statsActive ? 'page' : undefined}>Статистика</Link>
            <Link to="/recognition/jobs" aria-current={['jobs', 'job'].includes(route.kind) ? 'page' : undefined}>Обработка</Link>
          </>}
          <Link to="/health" aria-current={route.kind === 'health' ? 'page' : undefined}>Состояние сервисов</Link>
          {/* The sign-in has no address of its own: it opens in place of any page except this one. */}
          {session.kind === 'guest' && <Link to="/catalog" aria-current={view === 'login' ? 'page' : undefined}>Войти</Link>}
          {signedIn && session.mode === 'accounts' && <Link className="account-link" to="/account" aria-label={`Аккаунт: ${username}`}
            aria-current={route.kind === 'account' ? 'page' : undefined}>{username}</Link>}
        </nav>
      </header>

      <main id="main" ref={content}>
        <div className="intro">
          <p className="eyebrow">От чека к понятным покупкам</p>
          <h1 id="page-heading" ref={heading} tabIndex={-1}>{title}</h1>
          {route.kind === 'health' && <p className="intro-note">Техническая страница проверки соединения с сервером.</p>}
        </div>
        {catalogActive && view === 'page' && canModerate(session) && <nav className="main-navigation section-navigation" aria-label="Раздел каталога">
          <Link to="/catalog" aria-current={mergesActive || classificationActive ? undefined : 'page'}>Товары</Link>
          <Link to="/catalog/merges" aria-current={mergesActive ? 'page' : undefined}>Дубли</Link>
          <Link to="/catalog/classification" aria-current={classificationActive ? 'page' : undefined}>Категории</Link>
        </nav>}
        {statsActive && view === 'page' && <nav className="main-navigation section-navigation" aria-label="Раздел статистики">
          <Link to="/stats" aria-current={route.kind === 'spending' ? 'page' : undefined}>Траты</Link>
          <Link to="/stats/receipts" aria-current={route.kind === 'receipts-stats' ? 'page' : undefined}>Средний чек</Link>
        </nav>}
        {body}
      </main>
      <footer>Checkist · Каркас приложения</footer>
    </div>
  )
}
