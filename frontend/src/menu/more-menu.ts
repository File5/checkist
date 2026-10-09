/** Why the list behind «Ещё» changes: the button, the Esc key, a touch outside of the list,
 * a link of the list, the focus that left the button and the list.
 */
export type MoreMenuAction = 'toggle' | 'escape' | 'outside' | 'navigate' | 'focus-left'

/** Whether the list behind «Ещё» is open. Only the button opens it; everything else closes it. */
export function moreMenuReducer(open: boolean, action: MoreMenuAction): boolean {
  return action === 'toggle' ? !open : false
}

/** What else the menu hears: a press that began on the button or in the list, and the end of such a press
 * that brought no click (a cancelled touch, a key).
 */
export type MoreMenuEvent = MoreMenuAction | 'press' | 'release'

/** The list and the press that is under way inside of `.main-more`. */
export type MoreMenuState = { open: boolean; pressed: boolean }

export const MORE_MENU_CLOSED: MoreMenuState = { open: false, pressed: false }

/** The list behind «Ещё» together with the press inside of it. The focus that leaves during such a press
 * closes nothing: WebKit takes the focus away from the button before the click and gives it to no one
 * (`relatedTarget` is null), and a list hidden at that moment would never get the click. The click itself
 * decides then: a link closes the list, the button toggles it once. Every other event ends the press.
 */
export function moreMenuStep(state: MoreMenuState, event: MoreMenuEvent): MoreMenuState {
  const pressed = event === 'press' || (event === 'focus-left' && state.pressed)
  const open = event === 'press' || event === 'release' || (event === 'focus-left' && state.pressed)
    ? state.open
    : moreMenuReducer(state.open, event)
  return open === state.open && pressed === state.pressed ? state : { open, pressed }
}
