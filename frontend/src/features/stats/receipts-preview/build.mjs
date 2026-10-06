// Builds frontend/receipts-stats-preview/index.html: one self-contained page (inline CSS and script, no network)
// with the real components of the average receipt screen on the backend's reference answers. Run from frontend/:
//   node src/features/stats/receipts-preview/build.mjs
// The page is a snapshot: rebuild it after changing the components. It is not part of the application build.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const outDir = new URL('../../../../receipts-stats-preview/', import.meta.url)
const shared = { root, configFile: false, envFile: false, plugins: [react()], logLevel: 'error' }

// Server markup first: the page shows the screen even where scripts are not allowed to run.
const server = await createServer({ ...shared, server: { middlewareMode: true, fs: { strict: false } }, appType: 'custom' })
let markup
try {
  const { default: ReceiptsStatsDemo } = await server.ssrLoadModule('/src/features/stats/receipts-preview/demo.tsx')
  markup = renderToStaticMarkup(createElement(ReceiptsStatsDemo))
} finally {
  await server.close()
}

const result = await build({
  ...shared,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    lib: { entry: 'src/features/stats/receipts-preview/entry.tsx', formats: ['iife'], name: 'ReceiptsStatsPreview', fileName: 'preview' },
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
<title>Checkist — предпросмотр экрана «Средний чек» (Ф5)</title>
<style>
${styles.replaceAll('</style', '<\\/style')}
</style>
</head>
<body>
<div id="root">${markup}</div>
<script>
${script.replaceAll('</script', '<\\/script')}
</script>
</body>
</html>
`
await mkdir(outDir, { recursive: true })
await writeFile(new URL('index.html', outDir), html, 'utf8')
console.log(`receipts-stats-preview/index.html: ${html.length} characters, markup ${markup.length}, script ${script.length}, styles ${styles.length}`)
