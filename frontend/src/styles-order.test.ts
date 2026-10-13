import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/* The screens come in parts (screens.ts) but the styles do not (styles.ts): one stylesheet in the order it had while the
 * client was one script. Text of the files, not the build. */
const source = new URL('./', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const styles = raw('styles.ts')
const listed = [...styles.matchAll(/^import '\.\/([^']+\.css)'$/gm)].map((match) => match[1])
const sheets = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
  .filter((path) => path.endsWith('.css') && !/(^|[/-])preview\//.test(path))

describe('every stylesheet in one place, in the order of the cascade (src/styles.ts)', () => {
  it('lists every stylesheet of the client once', () => {
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...sheets].sort())
  })

  it('puts the screens first, then the tokens, App.css and ActionBar.css', () => {
    expect(listed.slice(-3)).toEqual(['theme/tokens.css', 'App.css', 'components/ActionBar.css'])
  })

  it('is the first import of main.tsx, which imports no stylesheet of its own', () => {
    const main = raw('main.tsx')
    expect(main.match(/^import .*$/m)?.[0]).toBe("import './styles'")
    expect(main).not.toMatch(/\.css'/)
  })
})
