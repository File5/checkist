/** When the thin bar at the top of the window shows (components/NetworkBar.tsx): only while requests of the API have
 * been on their way longer than `SHOW_AFTER_MS` — a fast answer never flickers it — and, once shown, at least
 * `KEEP_SHOWN_MS`, so a request that ends just after it does not blink it either. */
export const SHOW_AFTER_MS = 200
export const KEEP_SHOWN_MS = 400

/** The count of requests on their way (api/activity.ts). */
export type ActivitySource = {
  count: () => number
  subscribe: (listener: (count: number) => void) => () => void
}

/** Calls `show(true)` / `show(false)` on every change of the bar; the returned function stops watching. */
export function watchActivity(source: ActivitySource, show: (visible: boolean) => void,
  { showAfter = SHOW_AFTER_MS, keepShown = KEEP_SHOWN_MS }: { showAfter?: number; keepShown?: number } = {}): () => void {
  let visible = false
  let shownAt = 0
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const update = (count: number) => {
    if (count > 0) {
      // Busy again while the bar waits to go: it stays.
      if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined }
      if (visible || showTimer !== undefined) return
      showTimer = setTimeout(() => {
        showTimer = undefined
        if (source.count() === 0) return
        visible = true
        shownAt = Date.now()
        show(true)
      }, showAfter)
      return
    }
    if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined }
    if (!visible || hideTimer !== undefined) return
    hideTimer = setTimeout(() => {
      hideTimer = undefined
      visible = false
      show(false)
    }, Math.max(0, keepShown - (Date.now() - shownAt)))
  }
  const stop = source.subscribe(update)
  update(source.count())
  return () => {
    stop()
    if (showTimer !== undefined) clearTimeout(showTimer)
    if (hideTimer !== undefined) clearTimeout(hideTimer)
  }
}
