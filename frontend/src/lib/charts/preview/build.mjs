// Builds frontend/charts-preview/index.html: one self-contained page (inline CSS and script, no network)
// with the real PieChart and LineChart on synthetic data. Run from frontend/:
//   node src/lib/charts/preview/build.mjs
// `node src/lib/charts/preview/build.mjs pie-legend` builds frontend/pie-legend-preview/index.html instead: the legend
// rows of an item's parts (PieChartItem.action / children / childrenStatus) in the current theme tokens.
// The page is a snapshot: rebuild it after changing the components. It is not part of the application build.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { build, createServer } from 'vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const targets = {
  charts: { demo: 'demo.tsx', entry: 'entry.tsx', out: 'charts-preview', title: 'Checkist — предпросмотр графиков (Ф1)' },
  'pie-legend': { demo: 'legend-demo.tsx', entry: 'legend-entry.tsx', out: 'pie-legend-preview', title: 'Checkist — состав «Прочего» в легенде диаграммы' },
}
const target = targets[process.argv[2] ?? 'charts']
if (!target) throw new Error(`Unknown preview: ${process.argv[2]}. Known: ${Object.keys(targets).join(', ')}.`)
const outDir = fileURLToPath(new URL(`../../../../${target.out}/`, import.meta.url))
const shared = { root, configFile: false, envFile: false, plugins: [react()], logLevel: 'error' }

// Server markup first: the page shows the charts even where scripts are not allowed to run.
const server = await createServer({ ...shared, server: { middlewareMode: true }, appType: 'custom' })
let markup
try {
  const { default: ChartsDemo } = await server.ssrLoadModule(`/src/lib/charts/preview/${target.demo}`)
  markup = renderToStaticMarkup(createElement(ChartsDemo))
} finally {
  await server.close()
}

const result = await build({
  ...shared,
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    lib: { entry: `src/lib/charts/preview/${target.entry}`, formats: ['iife'], name: 'ChartsPreview', fileName: 'preview' },
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
<title>${target.title}</title>
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
await writeFile(new URL('index.html', `file:///${outDir.replaceAll('\\', '/')}`), html, 'utf8')
console.log(`${target.out}/index.html: ${html.length} characters, markup ${markup.length}, script ${script.length}, styles ${styles.length}`)
