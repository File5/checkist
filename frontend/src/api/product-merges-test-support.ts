/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'

const directory = new URL('../../../backend/merges/tests/fixtures/public/', import.meta.url)

/** Read the backend's public contract; never maintain a second copy of it. */
export function mergeFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
}
export function mergeFixtureNames(): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
}

/** Every error example of the backend with its HTTP status and the names the adapter keeps. */
export const errorFixtures: Record<string, { status: number; reason: string; fields?: string[] }> = {
  'error-invalid-parameter.json': { status: 400, reason: 'invalid_parameter', fields: ['target_product_id'] },
  'error-merge-conflict.json': { status: 409, reason: 'merge_conflict', fields: ['generic'] },
  'error-merge-resolved.json': { status: 409, reason: 'merge_resolved' },
  'error-merge-changed.json': { status: 409, reason: 'merge_changed' },
  'error-merge-busy.json': { status: 409, reason: 'merge_busy' },
}
