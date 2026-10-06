// Builds frontend/price-chart-preview/index.html: one self-contained page (inline CSS and script, no network)
// with the real «График цен» block on the backend's fixture answers. Run from frontend/:
//   node src/features/product/preview/build.mjs
// The page is a snapshot: rebuild it after changing the block. It is not part of the application build.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const outDir = fileURLToPath(new URL('../../../../price-chart-preview/', import.meta.url))
const fixturesUrl = new URL('../../../../../backend/api/tests/fixtures/stats/', import.meta.url)
const fixtures = {}
for (const name of (await readdir(fixturesUrl)).filter((file) => file.startsWith('price-series-')).sort()) {
  fixtures[name] = JSON.parse(await readFile(new URL(name, fixturesUrl), 'utf8'))
}
// The demo reads the answers from this global both here (server markup) and in the page.
globalThis.__PRICE_SERIES_FIXTURES__ = fixtures
const shared = { root, configFile: false, envFile: false, plugins: [react()], logLevel: 'error' }

// Server markup first: the page shows the block even where scripts are not allowed to run.
const server = await createServer({ ...shared, server: { middlewareMode: true }, appType: 'custom' })
let markup
try {
  const { default: PriceChartDemo } = await server.ssrLoadModule('/src/features/product/preview/demo.tsx')
  markup = renderToStaticMarkup(createElement(PriceChartDemo))
} finally {
  await server.close()
}

const result = await build({
  ...shared,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    lib: { entry: 'src/features/product/preview/entry.tsx', formats: ['iife'], name: 'PriceChartPreview', fileName: 'preview' },
  },
})
const output = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)
const script = output.filter((file) => file.type === 'chunk').map((file) => file.code).join('\n')
const styles = output.filter((file) => file.type === 'asset' && file.fileName.endsWith('.css')).map((file) => String(file.source)).join('\n')
if (!script || !styles) throw new Error('Preview build produced no script or no styles.')

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checkist — превью графика цен (Ф6)</title>
<style>
${styles.replaceAll('</style', '<\\/style')}
</style>
</head>
<body>
<div id="root">${markup}</div>
<script>
globalThis.__PRICE_SERIES_FIXTURES__ = ${JSON.stringify(fixtures).replaceAll('<', '\\u003c')}
</script>
<script>
${script.replaceAll('</script', '<\\/script')}
</script>
</body>
</html>
`
await mkdir(outDir, { recursive: true })
await writeFile(new URL('index.html', `file:///${outDir.replaceAll('\\', '/')}`), html, 'utf8')
console.log(`price-chart-preview/index.html: ${html.length} characters, markup ${markup.length}, script ${script.length}, styles ${styles.length}`)
