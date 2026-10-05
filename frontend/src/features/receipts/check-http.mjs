// Read-only CLI acceptance of the synthetic success2 dataset. No browser automation.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

function localOrigin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a local QA server')
  assert.equal(url.pathname, '/')
  assert.equal(url.search + url.hash + url.username + url.password, '')
  return url.origin
}

const origin = localOrigin(process.argv[2] ?? 'http://127.0.0.1:15173')
const backend = process.argv[3] ? localOrigin(process.argv[3]) : undefined
const pagedReceiptId = process.argv[4] ? Number(process.argv[4]) : undefined
if (pagedReceiptId !== undefined) assert.ok(Number.isSafeInteger(pagedReceiptId) && pagedReceiptId > 0)
const server = await createServer({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  server: { middlewareMode: true, hmr: false }, appType: 'custom',
})
const noop = () => {}
const loaded = (data) => ({ state: { kind: 'ok', data }, retry: noop })
const requireOk = (result) => { assert.equal(result.kind, 'ok', JSON.stringify(result)); return result.data }

try {
  const api = await server.ssrLoadModule('/src/api/receipts.ts')
  const recognition = await server.ssrLoadModule('/src/api/recognition.ts')
  const { ReceiptsView } = await server.ssrLoadModule('/src/features/receipts/ReceiptsPage.tsx')
  const { ReceiptView } = await server.ssrLoadModule('/src/features/receipts/ReceiptPage.tsx')
  const options = { baseUrl: `${origin}/api` }
  const first = requireOk(await api.getReceipts({ page_size: 1, ordering: '-purchased_at' }, options))
  assert.ok(first.count >= 2, 'Prepare a fresh QA database with double.png and FakeProvider success2')
  const second = requireOk(await api.getReceipts({ page: 2, page_size: 1, ordering: '-purchased_at' }, options))
  assert.notEqual(first.results[0].id, second.results[0].id)
  assert.ok(first.results[0].purchased_at >= second.results[0].purchased_at)
  const params = { q: 'MILCH', date_from: '2026-10-04', date_to: '2026-10-04', ordering: '-purchased_at' }
  const filtered = requireOk(await api.getReceipts(params, options))
  assert.ok(filtered.results.length > 0)
  const receipt = requireOk(await api.getReceipt(filtered.results[0].id, options))
  assert.equal(receipt.store.name, 'TESTMARKT')
  assert.equal(receipt.total, '4.42')
  const empty = requireOk(await api.getReceipts({ q: 'I3_NO_MATCH_20261005' }, options))
  assert.equal(empty.count, 0)
  const missingPage = await api.getReceipts({ page_size: 1, page: first.pages + 1 }, options)
  assert.equal(missingPage.kind, 'error')
  assert.equal(missingPage.reason, 'page_out_of_range')
  const [lines, discounts, taxes, images] = (await Promise.all([
    api.getReceiptLines(receipt.id, {}, options), api.getReceiptDiscounts(receipt.id, {}, options),
    api.getReceiptTaxes(receipt.id, {}, options), recognition.getReceiptImages({ receipt: receipt.id }, options),
  ])).map(requireOk)
  assert.equal(lines.count, 4)
  assert.equal(discounts.results[0].amount, '0.20')
  assert.equal(lines.results[0].paid_amount, '2.38')
  const deposit = lines.results.find((line) => line.kind === 'deposit')
  assert.ok(deposit)
  assert.ok(lines.results.some((line) => line.id === deposit.parent_id))
  assert.equal(taxes.count, 2)
  const missingLinesPage = await api.getReceiptLines(receipt.id, { page: lines.pages + 1 }, options)
  assert.equal(missingLinesPage.kind, 'error')
  assert.equal(missingLinesPage.reason, 'page_out_of_range')
  assert.ok(images.results.length > 0)
  for (const image of images.results) {
    assert.equal(image.receipt_id, receipt.id)
    const response = await fetch(`${origin}${image.image_url}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^image\//)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length > 0)
    if (backend) {
      const direct = await fetch(`${backend}${image.image_url}`)
      assert.equal(direct.status, 200)
      assert.ok(bytes.equals(Buffer.from(await direct.arrayBuffer())), 'Proxy must serve the same crop bytes')
    }
  }
  const view = {
    receiptId: receipt.id, header: loaded(receipt), lines: loaded(lines), images: loaded(images),
    discounts: loaded(discounts), taxes: loaded(taxes), pages: { images: 1, lines: 1, discounts: 1, taxes: 1 }, onPage: noop,
  }
  const html = renderToStaticMarkup(createElement(ReceiptView, view))
  for (const text of ['TESTMARKT', 'MILCH 1 L', '4,42 EUR', '2,38 EUR', 'Rabatt MILCH', 'НДС 7,00 %', 'НДС 19,00 %', 'Залог к']) assert.ok(html.includes(text), text)
  assert.ok(html.includes(`/catalog/products/${lines.results[0].product.id}`))
  assert.ok(html.includes(`/recognition/jobs/${images.results[0].job_id}`))
  const unmatched = lines.results.filter((line) => line.product === null)
  if (unmatched.length) assert.ok(html.includes('Товар не сопоставлен'))
  for (const image of images.results) assert.ok(html.includes(`/recognition/jobs/${image.job_id}`))
  const listHtml = renderToStaticMarkup(createElement(ReceiptsView, { query: { page: 1, ...params }, state: { kind: 'ok', data: filtered }, retry: noop }))
  assert.ok(listHtml.includes(`/receipts/${receipt.id}`))
  assert.ok(listHtml.includes('Миниатюра чека'))
  const partialHtml = renderToStaticMarkup(createElement(ReceiptView, { ...view, header: { state: { kind: 'error', reason: 'network' }, retry: noop } }))
  assert.ok(partialHtml.includes('Валюта: Не распознано'))
  assert.ok(partialHtml.includes('MILCH 1 L'))
  assert.ok(partialHtml.includes('Rabatt MILCH'))
  if (pagedReceiptId !== undefined) {
    const pagedHeader = requireOk(await api.getReceipt(pagedReceiptId, options))
    const firstLines = requireOk(await api.getReceiptLines(pagedReceiptId, { page: 1 }, options))
    const lastLines = requireOk(await api.getReceiptLines(pagedReceiptId, { page: 2 }, options))
    assert.equal(firstLines.count, 51)
    assert.equal(firstLines.results.length, 50)
    assert.equal(lastLines.results.length, 1)
    assert.equal(lastLines.results[0].parent_id, firstLines.results[0].id)
    const [pagedImages, pagedDiscounts, pagedTaxes] = (await Promise.all([
      recognition.getReceiptImages({ receipt: pagedReceiptId }, options),
      api.getReceiptDiscounts(pagedReceiptId, {}, options), api.getReceiptTaxes(pagedReceiptId, {}, options),
    ])).map(requireOk)
    const pageHtml = renderToStaticMarkup(createElement(ReceiptView, {
      ...view, receiptId: pagedReceiptId, header: loaded(pagedHeader), lines: loaded(lastLines), images: loaded(pagedImages),
      discounts: loaded(pagedDiscounts), taxes: loaded(pagedTaxes), pages: { ...view.pages, lines: 2 },
    }))
    assert.ok(pageHtml.includes('Страница 2 из 2'))
    assert.ok(pageHtml.includes(`Строка ID ${firstLines.results[0].id} (на другой странице строк)`))
  }
  console.log(JSON.stringify({ result: 'passed', receipt_id: receipt.id, receipts_count: first.count,
    lines: lines.count, discounts: discounts.count, taxes: taxes.count, images: images.count,
    unmatched_products_count: receipt.unmatched_products_count, unlinked_lines_count: unmatched.length, paged_receipt_id: pagedReceiptId,
    checks: ['real QA HTTP through Vite', 'runtime adapters', 'search/period/order/pagination', 'MEDIA bytes', 'SSR with real responses'],
    browser_ui: 'not tested' }))
} finally {
  await server.close()
}
