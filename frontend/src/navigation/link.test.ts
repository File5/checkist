import { describe, expect, it } from 'vitest'
import { shouldInterceptLink } from './link-policy'

const click = { button: 0, defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const current = 'http://localhost/catalog'

describe('native link click policy', () => {
  it('intercepts an ordinary internal click, including keyboard activation', () => {
    expect(shouldInterceptLink(click, '/health', current)).toBe(true)
    expect(shouldInterceptLink(click, '/catalog?page=2', current, '_self')).toBe(true)
  })
  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented'])('preserves %s clicks', (key) => {
    expect(shouldInterceptLink({ ...click, [key]: true }, '/health', current)).toBe(false)
  })
  it.each([1, 2])('preserves button %s', (button) => {
    expect(shouldInterceptLink({ ...click, button }, '/health', current)).toBe(false)
  })
  it('preserves new tabs, downloads, fragments and external protocols/origins', () => {
    expect(shouldInterceptLink(click, '/health', current, '_blank')).toBe(false)
    expect(shouldInterceptLink(click, '/health', current, undefined, true)).toBe(false)
    for (const href of ['#page-heading', '/health#main', 'https://example.com/catalog', 'mailto:user@example.com', 'javascript:alert(1)']) {
      expect(shouldInterceptLink(click, href, current)).toBe(false)
    }
  })
})
