import { useEffect, useLayoutEffect, useRef } from 'react'
import { buildRoute, Link, useNavigation } from './navigation'
import type { NavigationSnapshot, Route } from './navigation'
import HealthPage from './pages/HealthPage'
import CatalogPage from './features/catalog/CatalogPage'
import CategoryPage from './features/catalog/CategoryPage'
import ProductPage from './features/product/ProductPage'
import RequestState from './components/RequestState'

function pageTitle(route: Route) {
  switch (route.kind) {
    case 'catalog': return 'Каталог продуктов'
    case 'category': return 'Категория продуктов'
    case 'product': return 'Товар и история цен'
    case 'health': return 'Состояние сервисов'
    case 'invalid-query': return 'Некорректная ссылка'
    case 'not-found': return 'Страница не найдена'
  }
}

function pageContent({ route, returnTo }: NavigationSnapshot) {
  switch (route.kind) {
    case 'catalog': return <CatalogPage query={route.query} />
    case 'category': return <CategoryPage categoryId={route.categoryId} query={route.query} />
    case 'product': return <ProductPage productId={route.productId} query={route.query} returnTo={returnTo} />
    case 'health': return <HealthPage />
    case 'invalid-query': return <RequestState kind="empty" message="В адресе указаны некорректные фильтры или номер страницы. Сбросьте параметры и попробуйте снова." action={<Link className="action-link" to={route.resetTo} replace>Сбросить параметры</Link>} />
    case 'not-found': return <RequestState kind="empty" message="Такой страницы нет. Перейдите в каталог продуктов." action={<Link className="action-link" to="/catalog">В каталог</Link>} />
  }
}

export default function App() {
  const navigation = useNavigation()
  const { route } = navigation
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLElement>(null)
  const previousNavigation = useRef<NavigationSnapshot | undefined>(undefined)
  const pathname = navigation.href.split(/[?#]/)[0]
  const title = pageTitle(route)

  useLayoutEffect(() => {
    const previous = previousNavigation.current
    previousNavigation.current = navigation
    if (previous?.href.split(/[?#]/)[0] === pathname) return
    heading.current?.focus()
    if (previous?.route.kind !== 'product' || !previous.returnTo
      || (route.kind !== 'catalog' && route.kind !== 'category')
      || buildRoute(route) !== previous.returnTo || !content.current) return

    // The list loads asynchronously. Restore the selected link only while the
    // user has left focus on the transition heading; never interrupt their work.
    const productHref = buildRoute({ kind: 'product', productId: previous.route.productId, query: { page: 1 } })
    const stop = () => {
      observer.disconnect()
      document.removeEventListener('focusin', cancelOnFocus)
    }
    const cancelOnFocus = () => { if (document.activeElement !== heading.current) stop() }
    const restore = () => {
      if (document.activeElement !== heading.current) { stop(); return }
      const link = content.current?.querySelector<HTMLAnchorElement>(`a[href="${productHref}"]`)
      if (link) { stop(); link.focus() }
    }
    const observer = new MutationObserver(restore)
    observer.observe(content.current, { childList: true, subtree: true })
    document.addEventListener('focusin', cancelOnFocus)
    restore()
    return stop
  }, [navigation, pathname, route])

  useEffect(() => {
    document.title = `Checkist — ${title}`
  }, [title])

  const catalogActive = route.kind === 'catalog' || route.kind === 'category' || route.kind === 'product'
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
          <Link to="/catalog" aria-current={catalogActive ? 'page' : undefined}>Каталог</Link>
          <Link to="/health" aria-current={route.kind === 'health' ? 'page' : undefined}>Состояние сервисов</Link>
        </nav>
      </header>

      <main id="main" ref={content}>
        <div className="intro">
          <p className="eyebrow">От чека к понятным покупкам</p>
          <h1 id="page-heading" ref={heading} tabIndex={-1}>{title}</h1>
          {route.kind === 'health' && <p className="intro-note">Техническая страница проверки соединения с сервером.</p>}
        </div>
        {pageContent(navigation)}
      </main>
      <footer>Checkist · Каркас приложения</footer>
    </div>
  )
}
