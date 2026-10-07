// Builds src/features/login/preview/index.html: one self-contained page (inline CSS, script, logo and font, no
// network) with the real `/login` screen and a strip that chooses the answer of the sign-in handler.
// Run from frontend/:
//   node src/features/login/preview/build.mjs
// The page is a snapshot: rebuild it after changing the screen. It is not part of the application build.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const result = await build({
  root, configFile: false, envFile: false, plugins: [react()], logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    lib: { entry: 'src/features/login/preview/entry.tsx', formats: ['iife'], name: 'LoginPreview', fileName: 'preview' },
  },
})
const output = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)
const script = output.filter((file) => file.type === 'chunk').map((file) => file.code).join('\n')
const styles = output.filter((file) => file.type === 'asset' && file.fileName.endsWith('.css')).map((file) => String(file.source)).join('\n')
if (!script || !styles) throw new Error('Preview build produced no script or no styles.')
if (/url\((?!["']?data:)/.test(styles)) throw new Error('Preview styles refer to a file outside the page.')

// The page background follows the theme the way the application's page does once its styles use the tokens.
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Чекист — превью экрана входа</title>
<style>
${styles.replaceAll('</style', '<\/style')}
body { margin: 0; background: var(--ck-bg); }
</style>
</head>
<body>
<div id="root"></div>
<noscript>Превью экрана входа рисует скрипт этой страницы; без скриптов оно пустое.</noscript>
<script>
${script.replaceAll('</script', '<\/script')}
</script>
</body>
</html>
`
await writeFile(new URL('./index.html', import.meta.url), html, 'utf8')
console.log(`login preview/index.html: ${html.length} characters, script ${script.length}, styles ${styles.length}`)
