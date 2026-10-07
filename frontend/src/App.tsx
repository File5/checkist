import { useEffect, useLayoutEffect, useRef } from 'react'
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
import { LoginPage } from './features/login'
import { ThemeToggle } from './theme'
import emblem from './assets/brand/emblem-96.webp'
import emblem2x from './assets/brand/emblem-192.webp'

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
    case 'login': return 'Вход'
    case 'invalid-query': return 'Некорректная ссылка'
    case 'not-found': return 'Страница не найдена'
  }
}

function pageContent({ route, returnTo }: NavigationSnapshot) {
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
    case 'login': return <LoginPage />
    case 'invalid-query': return <RequestState kind="empty" message="В адресе указаны некорректные фильтры или номер страницы. Сбросьте параметры и попробуйте снова." action={<Link className="action-link" to={route.resetTo} replace>Сбросить параметры</Link>} />
    case 'not-found': return <RequestState kind="empty" message="Такой страницы нет. Перейдите в каталог продуктов." action={<><p className="request-state-note">Наружное наблюдение результатов не дало.</p><Link className="action-link" to="/catalog">В каталог</Link></>} />
  }
}

export default function App() {
  const navigation = useNavigation()
  const { route } = navigation
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLElement>(null)
  const mainNavigation = useRef<HTMLElement>(null)
  const previousNavigation = useRef<NavigationSnapshot | undefined>(undefined)
  const pathname = navigation.href.split(/[?#]/)[0]
  const title = pageTitle(route)

  useLayoutEffect(() => {
    const previous = previousNavigation.current
    previousNavigation.current = navigation
    if (previous?.href.split(/[?#]/)[0] === pathname) return
    // The login screen draws its own heading with the same id.
    const target = heading.current ?? document.getElementById('page-heading')
    target?.focus()
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
  }, [navigation, pathname, route])

  useEffect(() => {
    document.title = `Чекист — ${title}`
  }, [title])

  useLayoutEffect(() => {
    // On a narrow window the menu is one row scrolled sideways: keep the current item in view.
    const menu = mainNavigation.current
    const current = menu?.querySelector<HTMLElement>('[aria-current]')
    if (!menu || !current || menu.scrollWidth <= menu.clientWidth) return
    const offset = current.getBoundingClientRect().left - menu.getBoundingClientRect().left + menu.scrollLeft
    menu.scrollLeft = offset - (menu.clientWidth - current.offsetWidth) / 2
  }, [pathname])

  const mergesActive = route.kind === 'merges' || route.kind === 'merge'
  const classificationActive = route.kind === 'classification'
  const catalogActive = route.kind === 'catalog' || route.kind === 'category' || route.kind === 'product' || mergesActive || classificationActive
  const statsActive = route.kind === 'spending' || route.kind === 'receipts-stats'
  if (route.kind === 'login') return <LoginPage />
  return (
    <>
      <a className="skip-link" href="#page-heading">К содержимому</a>
      <header className="brand-bar">
        <Link className="brand" to="/catalog" aria-label="Чекист — каталог">
          <img className="brand-mark" src={emblem} srcSet={`${emblem} 1x, ${emblem2x} 2x`} width={44} height={44} alt="" />
          <span>Чекист</span>
        </Link>
        <div className="brand-actions">
          <Link to="/login">Вход</Link>
          <ThemeToggle placement="header" />
        </div>
        <nav className="main-navigation" aria-label="Основная навигация" ref={mainNavigation}>
          <Link to="/catalog" aria-current={catalogActive ? 'page' : undefined}>Каталог</Link>
          <Link to="/receipts" aria-current={['receipts', 'upload', 'receipt'].includes(route.kind) ? 'page' : undefined}>Чеки</Link>
          <Link to="/stats" aria-current={statsActive ? 'page' : undefined}>Статистика</Link>
          <Link to="/recognition/jobs" aria-current={['jobs', 'job'].includes(route.kind) ? 'page' : undefined}>Обработка</Link>
          <Link to="/health" aria-current={route.kind === 'health' ? 'page' : undefined}>Состояние сервисов</Link>
        </nav>
      </header>

      <div className="page">
        <main id="main" ref={content}>
          <div className="intro">
            <p className="eyebrow">Доверяй, но проверяй чек</p>
            <h1 id="page-heading" ref={heading} tabIndex={-1}>{title}</h1>
            {route.kind === 'health' && <p className="intro-note">Сводка о состоянии служб.</p>}
          </div>
          {catalogActive && <nav className="main-navigation section-navigation" aria-label="Раздел каталога">
            <Link to="/catalog" aria-current={mergesActive || classificationActive ? undefined : 'page'}>Товары</Link>
            <Link to="/catalog/merges" aria-current={mergesActive ? 'page' : undefined}>Дубли</Link>
            <Link to="/catalog/classification" aria-current={classificationActive ? 'page' : undefined}>Категории</Link>
          </nav>}
          {statsActive && <nav className="main-navigation section-navigation" aria-label="Раздел статистики">
            <Link to="/stats" aria-current={route.kind === 'spending' ? 'page' : undefined}>Траты</Link>
            <Link to="/stats/receipts" aria-current={route.kind === 'receipts-stats' ? 'page' : undefined}>Средний чек</Link>
          </nav>}
          {pageContent(navigation)}
        </main>
        <footer>Чекист · Продуктовая разведка · Совершенно несекретно</footer>
      </div>
    </>
  )
}
