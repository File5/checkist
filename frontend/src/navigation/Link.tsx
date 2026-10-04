import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { navigate } from './browser'
import { buildRoute } from './routes'
import type { NavigationTarget } from './controller'
import { shouldInterceptLink } from './link-policy'

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: NavigationTarget
  replace?: boolean
}

export default function Link({ to, replace, onClick, ...props }: LinkProps) {
  const href = typeof to === 'string' ? to : buildRoute(to)
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (shouldInterceptLink(event, href, window.location.href, props.target, event.currentTarget.hasAttribute('download'))) {
      event.preventDefault()
      navigate(to, { replace })
    }
  }
  return <a {...props} href={href} onClick={handleClick} />
}
