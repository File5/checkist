/** Service charges and tips in the review form: only a hint, the server decides on import.
 * The same rule and word list as backend/receipts/service_charges.py (MARKERS) — change both together. */
const MARKERS = [
  'обслуж', 'сервис', 'чаев', 'service', 'servis', 'tips', 'gratuity', 'trinkgeld', 'bedienung',
  'қызмет көрсет', 'қызмет ақы',
]

/** The category such a line gets on import: «Кафе и рестораны» › «Обслуживание и чаевые». */
export const SERVICE_CHARGE_CATEGORY = 'Обслуживание и чаевые'

/** A line of kind «Услуга» whose name looks like a service charge or a tip. */
export function isServiceCharge(kind: string, name: string): boolean {
  if (kind !== 'service') return false
  const folded = name.toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean).join(' ')
  return MARKERS.some((marker) => folded.includes(marker))
}
