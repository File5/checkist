// Builds frontend/spending-tail-preview/index.html: one self-contained page (inline CSS and script, no network)
// with the real result block of the spending screen and the composition of «Прочее» on the backend's example answers.
// Run from frontend/:
//   node src/features/stats/spending-tail-preview/build.mjs
// The page is a snapshot: rebuild it after changing the components. It is not part of the application build.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const outDir = new URL('../../../../spending-tail-preview/', import.meta.url)
const fixtureDir = new URL('../../../../../backend/api/tests/fixtures/stats/', import.meta.url)
const shared = { root, configFile: false, envFile: false, plugins: [react()], logLevel: 'error' }

const names = { product: 'spending-product', generic: 'spending-generic', store: 'spending-store' }
const fixtures = {}
for (const [key, name] of Object.entries(names)) fixtures[key] = JSON.parse(await readFile(new URL(`${name}.json`, fixtureDir), 'utf8'))

// Server markup first: the page shows the open composition even where scripts are not allowed to run.
const server = await createServer({ ...shared, server: { middlewareMode: true }, appType: 'custom' })
let markup
try {
  const { default: SpendingTailDemo } = await server.ssrLoadModule('/src/features/stats/spending-tail-preview/demo.tsx')
  markup = renderToStaticMarkup(createElement(SpendingTailDemo, { fixtures }))
} finally {
  await server.close()
}

const result = await build({
  ...shared,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_API_BASE_URL': '"/api"' },
  build: {
    write: false,
    cssCodeSplit: false,
    lib: { entry: 'src/features/stats/spending-tail-preview/entry.tsx', formats: ['iife'], name: 'SpendingTailPreview', fileName: 'preview' },
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
<title>Checkist — раскрытие «Прочего» на экране трат (Ф2), предпросмотр</title>
<style>
${styles.replaceAll('</style', '<\\/style')}
</style>
</head>
<body>
<div id="root">${markup}</div>
<script type="application/json" id="fixtures">${JSON.stringify(fixtures).replaceAll('<', '\\u003c')}</script>
<script>
${script.replaceAll('</script', '<\\/script')}
</script>
</body>
</html>
`
await mkdir(outDir, { recursive: true })
await writeFile(new URL('index.html', outDir), html, 'utf8')
console.log(`spending-tail-preview/index.html: ${html.length} characters, markup ${markup.length}, script ${script.length}, styles ${styles.length}`)
