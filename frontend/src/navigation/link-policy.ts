export interface LinkClick {
  button: number
  defaultPrevented: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Native downloads, fragments, external URLs and modified clicks keep browser behavior. */
export function shouldInterceptLink(
  click: LinkClick,
  href: string,
  currentHref: string,
  target?: string,
  download?: boolean,
): boolean {
  if (click.defaultPrevented || click.button !== 0 || click.altKey || click.ctrlKey || click.metaKey || click.shiftKey) return false
  if (download || (target && target.toLowerCase() !== '_self')) return false
  try {
    const current = new URL(currentHref)
    const url = new URL(href, current)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === current.origin && !url.hash
  } catch {
    return false
  }
}
