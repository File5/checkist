/** The way a spend was paid (`Receipt.payment_method`, 2026-10-13): `''` — not said. A spend has one; an income has none. */
export const paymentMethods = ['kaspi_gold', 'forte', 'cash', 'crypto', 'card'] as const
export type PaymentMethod = typeof paymentMethods[number]
export type PaymentMethodValue = PaymentMethod | ''

/** The names of the chips, the page of a spend and the history of a regular payment. */
export const methodLabels: Record<PaymentMethod, string> = {
  kaspi_gold: 'Kaspi Gold', forte: 'ForteBank', cash: 'Наличные', crypto: 'Криптовалюта', card: 'Другая карта',
}
/** The short name under the amount of a row of «Траты»: it fits whole next to the amount. */
export const methodShort: Record<PaymentMethod, string> = { kaspi_gold: 'Kaspi', forte: 'Forte', cash: 'Наличные', crypto: 'Крипта', card: 'Карта' }

export const isPaymentMethod = (value: unknown): value is PaymentMethodValue =>
  value === '' || (paymentMethods as readonly unknown[]).includes(value)

const KEY = 'checkist.paymentMethod'

/** The method chosen last on this device: the default of the next form. `''` when none, or the storage is closed. */
export function lastMethod(): PaymentMethodValue {
  try {
    const value = localStorage.getItem(KEY)
    return isPaymentMethod(value) ? value : ''
  } catch {
    return ''
  }
}

export function rememberMethod(method: PaymentMethodValue) {
  try {
    if (method) localStorage.setItem(KEY, method)
    else localStorage.removeItem(KEY)
  } catch { /* a private window or blocked storage: the form just starts without a default */ }
}
