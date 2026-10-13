/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { baseBlock, inBase } from './base-currency.ts'

const directory = new URL('../../../backend/api/tests/fixtures/stats/', import.meta.url)

/** Read the backend's real answers; never maintain a second copy of them. A fresh object on every call. */
export function statsFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
}
export function statsFixtureNames(): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
}
export const fixturesOf = (prefix: string) => statsFixtureNames().filter((name) => name.startsWith(prefix))
/** The example as a reader returns it: the block in the family's base currency in place of the blocks per currency. */
export function statsAnswer(name: string): unknown {
  const field = name.startsWith('compare-') ? { from: 'in_base', to: 'currencies' }
    : name.startsWith('trends-limits') ? { from: 'base_limits', to: 'limits', list: true } : baseBlock
  return inBase(statsFixture(name), field)
}

/** Every error example of the backend with its HTTP status and the names the adapter keeps. */
export const statsErrorFixtures: Record<string, { status: number; reason: string; fields?: string[] }> = {
  'error-invalid-parameter.json': {
    status: 400, reason: 'invalid_parameter', fields: ['date_from', 'country', 'currency', 'store', 'group_by', 'category', 'limit'],
  },
  'error-required-parameter.json': { status: 400, reason: 'invalid_parameter', fields: ['base_from', 'base_to', 'current_from', 'current_to'] },
  'error-periods-overlap.json': { status: 400, reason: 'invalid_parameter', fields: ['current_from'] },
  'error-range-too-large.json': { status: 400, reason: 'range_too_large' },
  'error-permission-denied.json': { status: 403, reason: 'permission_denied' },
  'error-not-found.json': { status: 404, reason: 'not_found' },
  'error-trends-period.json': { status: 400, reason: 'invalid_parameter', fields: ['to'] },
}
