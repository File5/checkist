import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CategoryIconPicker, { IconChoices } from './CategoryIconPicker'
import { categoryIconFailure as iconFailure } from '../../lib/category-icons'
import type { IconChoicesProps } from './CategoryIconPicker'

const noIcons = (html: string) => html.replace(/<svg\b.*?<\/svg>/g, '')
const choices = (props: Partial<IconChoicesProps> = {}) => renderToStaticMarkup(<IconChoices
  icon={{ id: 7, icon: 'cart', own_icon: null }} root={false} saving={false} onChoose={() => {}} {...props} />)

describe('«Значок в тратах» of a catalog category (Vitest/SSR, not browser visual acceptance)', () => {
  it('presses «Как у родителя» with the picture it gives, then every picture by its name', () => {
    const html = choices()
    expect(html).toMatch(/<button type="button" class="ck-catalog-icon-inherit" aria-pressed="true"><svg class="ck-icon"[^>]*>.*?<\/svg>Как у родителя<\/button>/)
    expect(noIcons(html)).toContain('<button type="button" aria-pressed="false" aria-label="Тележка" title="Тележка"></button>')
    expect(html.match(/aria-pressed=/g)).toHaveLength(19)
    expect(html).toContain('<h2 id=')
  })

  it('presses the own picture, says «Без значка» at a root and reports the result', () => {
    const own = noIcons(choices({ icon: { id: 7, icon: 'bus', own_icon: 'bus' }, root: true, message: 'Значок сохранён.' }))
    expect(own).toContain('<button type="button" class="ck-catalog-icon-inherit" aria-pressed="false">Без значка</button>')
    expect(own).toContain('<button type="button" aria-pressed="true" aria-label="Автобус" title="Автобус"></button>')
    expect(own).toContain('<p class="ck-catalog-note" role="status">Значок сохранён.</p>')
    const busy = choices({ saving: true, message: iconFailure({ reason: 'permission_denied' }), failed: true })
    expect(busy).toContain('aria-busy="true"')
    expect(busy).toContain('aria-disabled="true"')
    expect(busy).toContain('<p class="ck-catalog-field-error" role="status">Менять значок может только модератор каталога.</p>')
  })

  it('explains refusals in its own words and shows nothing to a person who is not a moderator', () => {
    expect([iconFailure({ reason: 'not_found' }), iconFailure({ reason: 'network' }), iconFailure({ reason: 'invalid_parameter' })])
      .toEqual(['Этой категории больше нет.', 'Не удалось связаться с сервером. Повторите.', 'Не удалось сохранить значок. Повторите.'])
    expect(renderToStaticMarkup(<CategoryIconPicker categoryId={7} root={false} />)).toBe('')
  })
})
