import { mutate } from './local.ts'
import { getLocalJson } from './recognition.ts'
import { array, currency, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import { isUserSettings } from './session-schema.ts'
import type { UserSettings } from './session.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

/** A currency known to the server: `code` (ISO 4217) and its name. */
export type CurrencyOption = { code: string; name: string }
/** `GET /api/me/settings/`: the settings of the user and every currency the server knows. */
export type SettingsAnswer = UserSettings & { currencies: CurrencyOption[] }

const isCurrencyOption = object<CurrencyOption>({ code: currency, name: text })
const hasCurrencies = object<{ currencies: CurrencyOption[] }>({ currencies: array(isCurrencyOption) })
export const isSettingsAnswer: Guard<SettingsAnswer> = (value): value is SettingsAnswer => isUserSettings(value) && hasCurrencies(value)

export function getSettings(options: RequestOptions = {}): Promise<LocalApiResult<SettingsAnswer>> {
  return getLocalJson('me/settings/', {}, isSettingsAnswer, options)
}
/** Saves the main currency (`null` — none); the answer is the same as `getSettings`. Refusal: `400 invalid_parameter`. */
export function saveSettings(input: Partial<UserSettings>, options: RequestOptions = {}): Promise<LocalApiResult<SettingsAnswer>> {
  return mutate('me/settings/', JSON.stringify(input), isSettingsAnswer, options, false, undefined, { method: 'PATCH' })
}
