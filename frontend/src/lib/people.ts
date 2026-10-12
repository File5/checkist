/** People of the family as the screens show them. The server sends a username (the key of filters and records) and,
 * next to it, `display_name` — «Имя» from the user form of the admin, the username when it is empty. An older server
 * or an answer cached before the names leaves `display_name` out: the username is shown then. */

export type Person = { username: string; display_name: string }

/** The name to show for `username`: `name` when it is a non-blank text, the username otherwise. */
export function personName(username: string, name?: string | null): string {
  return typeof name === 'string' && name.trim() ? name.trim() : username
}

/** Who added a receipt or a spend: `owner_name`, falling back to the `owner` username. */
export function ownerName(item: { owner: string; owner_name?: string | null }): string {
  return personName(item.owner, item.owner_name)
}

/** The people of a list of usernames: names from `people` where they are, the username otherwise; the order of `usernames`. */
export function peopleOf(usernames: readonly string[], people?: readonly Person[] | null): Person[] {
  const names = new Map((people ?? []).map((person) => [person.username, person.display_name]))
  return usernames.map((username) => ({ username, display_name: personName(username, names.get(username)) }))
}

/** «А» for «Андрей», «АМ» for «Анна Мария» or «anna_maria»: up to two letters of the name's parts. */
export function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const letters = (parts.length ? parts : [name]).slice(0, 2).map((part) => [...part][0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

/** A person object in an answer: a non-empty username up to Django's 150 characters and a text name. */
export function isPerson(value: unknown): value is Person {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { username, display_name: name } = value as Record<string, unknown>
  return typeof username === 'string' && username.length > 0 && username.length <= 150 && typeof name === 'string'
}
