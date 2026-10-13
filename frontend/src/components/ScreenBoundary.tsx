import { Component } from 'react'
import type { ReactNode } from 'react'
import type { Route } from '../navigation'
import { ScreenLoadError, routeScreens } from '../screens'
import RequestState from './RequestState'
import { SpendsTopSkeleton } from './Skeleton'
import type { SkeletonShape } from './Skeleton'

/** The skeleton of the screen of an address: the same shape as while its data loads, so the waits before it (the check of
 * the sign-in, the script of the screen) and its own look like one. «Траты» keeps the room of its search and filters. */
export function ScreenSkeleton({ kind, message }: { kind: Route['kind']; message: string }) {
  const shape: SkeletonShape = kind === 'dashboard' ? 'home' : kind === 'receipts' ? 'spends' : 'page'
  const state = <RequestState kind="loading" message={message} shape={shape} />
  return kind === 'receipts' ? <div className="ck-skel-screen"><SpendsTopSkeleton />{state}</div> : state
}

/** The fallback of `Suspense` while the script of a screen is on its way. */
export function ScreenFallback({ kind }: { kind: Route['kind'] }) {
  // The markup of a server (the tests of the shell) shows the fallback for a screen that threw as well, and says nothing:
  // a loaded screen never waits for its script, so there its fallback is its error — the test must not pass over it.
  if (import.meta.env.MODE === 'test' && routeScreens[kind]?.isLoaded()) {
    throw new Error(`The screen of «${kind}» is loaded but did not render: render it alone to see its error`)
  }
  return <ScreenSkeleton kind={kind} message="Открываем экран…" />
}

type Props = { resetKey: string; children: ReactNode }
type State = { failed?: unknown; resetKey: string }

/** Catches only a script of a screen that did not arrive (`ScreenLoadError`, screens.ts): «Повторить» reloads the page,
 * which also takes a new deploy. Every other error passes on, as it did before the screens came in parts. Another
 * address takes the failure off. */
export default class ScreenBoundary extends Component<Props, State> {
  state: State = { resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: undefined, resetKey: props.resetKey }
  }

  render() {
    const { failed } = this.state
    if (failed === undefined) return this.props.children
    if (!(failed instanceof ScreenLoadError)) throw failed
    return <RequestState kind="error" title="Экран не загрузился" message="Проверьте соединение и обновите страницу."
      onRetry={() => window.location.reload()} />
  }
}
