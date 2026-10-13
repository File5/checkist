/** How a money amount is shown (2026-10-13): in whole units, rounded up (the default), or exactly, with two places.
 * A choice of the device, like the theme and the pictures of the spend rows: `localStorage`, every access guarded.
 * Only the display follows it (`lib/money.ts`): the server, the input fields and the request bodies know nothing. */
import { useSyncExternalStore } from 'react'

export type MoneyDigits = 'whole' | 'cents'

export const moneyDigitsStorageKey = 'checkist.moneyDigits'

export function parseMoneyDigits(value: unknown): MoneyDigits {
  return value === 'cents' ? 'cents' : 'whole'
}

export const moneyDigitsNames: [MoneyDigits, string][] = [['whole', 'Целые'], ['cents', 'С копейками']]

let current: MoneyDigits | undefined
const listeners = new Set<() => void>()

function read(): MoneyDigits {
  try {
    return parseMoneyDigits(window.localStorage.getItem(moneyDigitsStorageKey))
  } catch {
    // Blocked storage (or no browser): the default.
    return 'whole'
  }
}

/** The choice of the device right now: the storage is read once, then the answer lives in the module. */
export function moneyDigits(): MoneyDigits {
  current ??= read()
  return current
}

export function setMoneyDigits(value: MoneyDigits) {
  try {
    window.localStorage.setItem(moneyDigitsStorageKey, value)
  } catch {
    // Without storage the choice lives until the page is closed.
  }
  current = value
  for (const listener of listeners) listener()
}

/** Follows the choice: `setMoneyDigits` here and the `storage` event of another tab. Returns the way to stop. */
export function subscribeMoneyDigits(listener: () => void) {
  // Another tab changed the choice (or cleared the storage): followed here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== moneyDigitsStorageKey && event.key !== null) return
    current = read()
    listener()
  }
  listeners.add(listener)
  try {
    window.addEventListener('storage', onStorage)
  } catch {
    // No window: nothing to follow.
  }
  return () => {
    listeners.delete(listener)
    try {
      window.removeEventListener('storage', onStorage)
    } catch {
      // No window.
    }
  }
}

/** The choice of the device; a render without a browser (the markup tests) reads the same store. */
export function useMoneyDigits(): MoneyDigits {
  return useSyncExternalStore(subscribeMoneyDigits, moneyDigits, moneyDigits)
}

/** Tests only: forget the choice, the next read asks the storage again. */
export function resetMoneyDigits() {
  current = undefined
}
