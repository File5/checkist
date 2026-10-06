/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'

const directory = new URL('../../../backend/classification/tests/fixtures/public/', import.meta.url)

/** Read the backend's public contract; never maintain a second copy of it. */
export function classificationFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
}
export function classificationFixtureNames(): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
}

/** Bodies the client sends; the adapters must produce exactly these. */
export const requestFixtures = ['confirm-request.json', 'confirm-other-request.json', 'reject-request.json', 'confirm-many-request.json']

/** Every error example of the backend with its HTTP status and the names the adapter keeps. */
export const errorFixtures: Record<string, { status: number; reason: string; fields?: string[] }> = {
  'error-classification-busy.json': { status: 409, reason: 'classification_busy' },
  'error-classification-changed.json': { status: 409, reason: 'classification_changed' },
  'error-classification-changed-items.json': { status: 409, reason: 'classification_changed', fields: ['items.0'] },
  'error-classification-resolved.json': { status: 409, reason: 'classification_resolved' },
  'error-classification-resolved-items.json': { status: 409, reason: 'classification_resolved', fields: ['items.1'] },
  'error-csrf-failed.json': { status: 403, reason: 'csrf_failed' },
  'error-database-unavailable.json': { status: 503, reason: 'database_unavailable' },
  'error-invalid-parameter.json': { status: 400, reason: 'invalid_parameter', fields: ['generic_id'] },
  'error-invalid-parameter-items.json': { status: 400, reason: 'invalid_parameter', fields: ['items'] },
  'error-invalid-parameter-service.json': { status: 400, reason: 'invalid_parameter', fields: ['generic_id'] },
  'error-invalid-request.json': { status: 400, reason: 'invalid_request' },
  'error-not-found.json': { status: 404, reason: 'not_found' },
  'error-page-out-of-range.json': { status: 404, reason: 'page_out_of_range' },
  'error-permission-denied.json': { status: 403, reason: 'permission_denied' },
}
