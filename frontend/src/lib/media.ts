/** Only local MEDIA paths are usable in image src/href. Return null for unsafe input.
 * Reject encoded separators/dots too: browsers and proxies can normalize them.
 */
export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/media/') || value.length <= 7
    || unsafeCharacters(value)) return null
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return null }
  if (unsafeCharacters(decoded) || decoded.includes('%')
    || /%(?:2f|5c|2e)/i.test(value)) return null
  const segments = decoded.slice(7).split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return value
}

function unsafeCharacters(value: string): boolean {
  return /[\\?#\s]/u.test(value) || [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 31 || (code >= 127 && code <= 159)
  })
}
