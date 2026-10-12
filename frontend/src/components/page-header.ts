import { createContext, useContext, useLayoutEffect } from 'react'

/** The header row of the shell (App.tsx): «назад» or a page's own control before the heading, the heading (`h1`,
 * focused by the shell after every transition) and a slot after it. A page fills the row through this context
 * (`HeaderSlot` of PageHeader.tsx, `usePageTitle`) instead of drawing a second heading of its own: «Главная» puts
 * «‹ Октябрь 2026 ›» and the family there. */
export type PageHeaderSlots = {
  /** Before the heading, after «назад»: a round control of the page (the previous month). */
  start: HTMLElement | null
  /** After the heading; a part that belongs on the right edge takes `margin-left: auto` itself. */
  end: HTMLElement | null
  /** The visible text of the heading instead of the name of the page; `undefined` gives the name back. */
  setTitle: (title: string | undefined) => void
}

export const PageHeaderContext = createContext<PageHeaderSlots | null>(null)

/** The heading of the page while the screen is shown: «Октябрь 2026» on «Главная», the name of a category on its
 * spends. The shell keeps focusing the same `h1`; the name of the page stays in the title of the tab. Outside of the
 * shell (a markup test) it does nothing. */
export function usePageTitle(title: string | undefined) {
  const setTitle = useContext(PageHeaderContext)?.setTitle
  useLayoutEffect(() => {
    if (!setTitle) return
    setTitle(title)
    return () => setTitle(undefined)
  }, [setTitle, title])
}
