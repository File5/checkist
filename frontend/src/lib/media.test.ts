import { expect, it } from 'vitest'
import { safeMediaUrl } from './media'

it.each(['/media/originals/a.png', '/media/crops/a-b_1.webp', '/media/чек.png', '/media/%D1%87%D0%B5%D0%BA.png'])('accepts local MEDIA path %s', (url) => {
  expect(safeMediaUrl(url)).toBe(url)
})
it.each([null, undefined, 1, '', '/media/', '/mediax/a.png', 'media/a.png', 'https://example.test/media/a.png', '//example.test/media/a.png',
  'data:image/png;base64,x', 'javascript:alert(1)', '/media/../a', '/media/./a', '/media/a//b', '/media/a\\b', '/media/a?x=1', '/media/a#x',
  '/media/%2e%2e/a', '/media/a%2fb', '/media/%5c/a', '/media/%252e%252e/a', '/media/%', '/media/a\n.png', '/media/%00.png', '/media/a b.png',
])('rejects unsafe path %s', (url) => { expect(safeMediaUrl(url)).toBeNull() })
