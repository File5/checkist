/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type { IssueContext, IssueSeverity, RecognitionIssue } from './recognition-types.ts'

/** Read the backend's public contract; never maintain a second copy of it. */
export function publicFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../backend/recognition/tests/fixtures/public/${name}`, import.meta.url), 'utf8'))
}

type FullIssue = Required<RecognitionIssue>
/** Issue in the new server shape. Internal causes stay behind code=invalid_value and field="/" as on the server. */
export function issue(reason: string, severity: IssueSeverity, context: Partial<IssueContext> = {}, base: Partial<RecognitionIssue> = {}): FullIssue {
  return {
    code: 'invalid_value', field: '/', message: 'Значение не прошло проверку.', reason, severity,
    context: { entity: 'receipt', index: null, position: null, attribute: null, ...context }, ...base,
  }
}
/** API issues of the fake scenario tax_evidence_missing in the order of the real server: 2 private requisites, 25 line rates, 2 tax totals. */
export function taxEvidenceMissingIssues(): FullIssue[] {
  return [
    ...[0, 1].map(() => issue('optional_omitted', 'warning', { attribute: 'receipt_metadata' })),
    ...Array.from({ length: 25 }, (_, index) => issue('optional_omitted', 'warning',
      { entity: 'line', index, position: index + 1, attribute: 'tax_rate' }, { field: `/lines/${index}/tax_rate` })),
    ...[0, 1].map((index) => issue('optional_omitted', 'warning', { entity: 'tax', index }, { field: `/taxes/${index}` })),
  ]
}
