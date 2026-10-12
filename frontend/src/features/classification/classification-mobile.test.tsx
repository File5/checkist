import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClassificationView } from './ClassificationPage'

// The phone view: the hook of the window width answers «narrow» for this file only.
vi.mock('../../lib/cards', async (original) => ({ ...await original<typeof import('../../lib/cards')>(), useNarrow: () => true }))

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const noop = () => {}

describe('phone view of the classification screen', () => {
  it('draws the state filter as one row of chips, the current state marked', () => {
    const html = renderToStaticMarkup(<ClassificationView query={{ status: 'confirmed', page: 1 }} state={{ kind: 'loading' }} list={{ kind: 'loading' }}
      action={{ kind: 'idle' }} onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop}
      onAction={noop} onOpen={noop} onClose={noop} />)
    const nav = /<nav class="ck-class-filter" aria-label="Состояние записей">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
    expect(nav).toMatch(/^<div class="ck-chip-scroller"><div class="ck-chip-scroller-track" role="region" aria-label="Состояния" tabindex="0"><a /)
    expect(nav).toMatch(/<a class="ck-chip" aria-current="true" href="\/catalog\/classification\?status=confirmed">Подтверждённые<\/a>/)
  })

  it('pins «Применить выбор» of the long list of options above the bottom menu', () => {
    expect(source('./GenericChooser.tsx')).toMatch(/<div className="ck-class-actions ck-action-bar">\s*<button type="button" disabled=\{busy \|\| chosen === undefined\} onClick=\{onApply\}>/)
  })
})
