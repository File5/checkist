/** Why the list behind «Ещё» changes: the button, the Esc key, a touch outside of the list,
 * a link of the list, the focus that left the button and the list.
 */
export type MoreMenuAction = 'toggle' | 'escape' | 'outside' | 'navigate' | 'focus-left'

/** Whether the list behind «Ещё» is open. Only the button opens it; everything else closes it. */
export function moreMenuReducer(open: boolean, action: MoreMenuAction): boolean {
  return action === 'toggle' ? !open : false
}
