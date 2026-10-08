import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { NavigationSnapshot } from '../navigation'
import { buildRoute } from '../navigation'
import type { NavigableRoute } from '../navigation'

const state = vi.hoisted(() => ({ snapshot: undefined as NavigationSnapshot | undefined }))
vi.mock('../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../navigation')>(), useNavigation: () => state.snapshot!,
}))
// The shell needs to know who works: these tests check the unchanged interface of local_single.
vi.mock('../session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session')>(),
  useSession: () => ({ kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }),
}))

describe('new page wiring (SSR only, no browser interaction)', () => {
  it.each<[NavigableRoute, string, string, string]>([
    [{ kind: 'receipts', query: { page: 2 } }, 'Чеки', 'Страница 2', '/receipts'],
    [{ kind: 'upload' }, 'Загрузка фото чеков', 'Получаем лимиты и токен безопасности…', '/receipts'],
    [{ kind: 'receipt', receiptId: 71 }, 'Чек', 'Страница чека\u00a0№71', '/receipts'],
    [{ kind: 'jobs', query: { page: 3 } }, 'Обработка', 'Задания · Страница 3', '/recognition/jobs'],
    [{ kind: 'job', jobId: 31 }, 'Задание обработки', 'Задание\u00a0№31', '/recognition/jobs'],
  ])('mounts %j with the shell title, props and active menu', (route, title, text, menu) => {
    state.snapshot = { route, href: buildRoute(route) }
    const html = renderToStaticMarkup(<App />)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain(`${title}</h1>`)
    expect(html).toContain(text)
    const activeLinks = html.match(/<a\b[^>]*aria-current="page"[^>]*>/g)
    expect(activeLinks).toHaveLength(1)
    expect(activeLinks![0]).toContain(`href="${menu}"`)
    expect(html).toContain('href="/catalog"')
    expect(html).toContain('href="/health"')
  })
  it('passes filtered list context into the receipt/job return link', () => {
    for (const [route, returnTo] of [
      [{ kind: 'receipt', receiptId: 71 }, '/receipts?store=51&page=2'],
      [{ kind: 'job', jobId: 31 }, '/recognition/jobs?status=failed&page=3'],
    ] as const) {
      state.snapshot = { route, href: buildRoute(route), returnTo }
      expect(renderToStaticMarkup(<App />)).toContain(`href="${returnTo.replace('&', '&amp;')}"`)
    }
  })
})
