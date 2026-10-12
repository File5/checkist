import { apiUrl } from '../../api/http'
import { getLocalJson } from '../../api/local'
import { amount, array, currency, isId, nonNegativeInteger, nullable, object, text } from '../../api/schema'
import type { Guard } from '../../api/schema'
import type { LocalApiResult, RequestOptions } from '../../api/types'
import { isPerson } from '../../lib/people'
import type { Person } from '../../lib/people'
import { apiParams } from './export-query'
import type { ExportQuery } from './export-query'

export type PreviewCurrency = { currency: string; receipts_count: number; lines_count: number; total: string }
export type PreviewStore = { id: number; name: string; city: string; country: string }
/** The light answer of the preview: `include=summary,stores` — no receipts, no lines. */
export type ExportPreview = {
  people: Person[]
  stores: PreviewStore[]
  summary: { receipts_count: number; lines_count: number; max_receipts: number; currencies: PreviewCurrency[] }
}

const isCurrencyBlock = object<PreviewCurrency>({ currency, receipts_count: nonNegativeInteger, lines_count: nonNegativeInteger, total: amount })
const isStore = object<PreviewStore>({ id: isId, name: text, city: text, country: nullable(text) })
const isSummary = object<ExportPreview['summary']>({
  receipts_count: nonNegativeInteger, lines_count: nonNegativeInteger, max_receipts: nonNegativeInteger, currencies: array(isCurrencyBlock),
})
export const isExportPreview: Guard<ExportPreview> = object<ExportPreview>({ people: array(isPerson), stores: array(isStore), summary: isSummary })

export const previewSections = ['summary', 'stores'] as const

const base = () => import.meta.env.VITE_API_BASE_URL || '/api'

/** Counts and sums of what would be exported, the family and the names of the stores in the selection. */
export function getExportPreview(query: ExportQuery, today: string, options: RequestOptions = {}): Promise<LocalApiResult<ExportPreview>> {
  return getLocalJson('export/', apiParams(query, today, previewSections), isExportPreview, options)
}

/** The address of the document itself: «Скачать JSON» adds `download=1` (an attachment), «Открыть» shows it. */
export function exportDocumentUrl(query: ExportQuery, today: string, download: boolean): string {
  return apiUrl(base(), 'export/', { ...apiParams(query, today), ...(download && { download: '1' }) })
}
