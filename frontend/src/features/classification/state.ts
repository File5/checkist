import { classificationConfirmLimit } from '../../api/product-classifications'
import type {
  Classification, ClassificationConfirmItem, ClassificationParams, ClassificationRunRequest, ClassificationState,
  ClassificationSuggested,
} from '../../api/product-classifications'
import type { GenericProduct, Page } from '../../api/types'
import type { ClassificationQuery } from '../../navigation'
import { runActive } from './list-sync'

/** One page holds as many records as the server allows, so a group is rarely split between pages. */
export const listPageSize = 200

/** Pending records come grouped by the suggested generic product; every other filter is a plain list, new first. */
export function listParams(query: ClassificationQuery): ClassificationParams {
  const pending = query.status === undefined
  return {
    ...(query.status !== 'all' && { status: query.status ?? 'pending' }), ...(query.product !== undefined && { product: query.product }),
    page: query.page, page_size: listPageSize, ordering: pending ? 'generic' : '-id',
  }
}

export type SuggestionGroup = {
  generic: ClassificationSuggested['generic']; category: ClassificationSuggested['category']
  /** Pending records with this suggestion in the whole database; the page may hold fewer. */
  pendingCount: number
  records: Classification[]
}
/** Groups in the order the server sent them: its string order is not the alphabet and is never re-sorted here. */
export function groupRecords(records: Classification[]): SuggestionGroup[] {
  const groups = new Map<number, SuggestionGroup>()
  for (const record of records) {
    const { generic, category, pending_count: pendingCount } = record.suggested
    const group = groups.get(generic.id)
    if (group) group.records.push(record)
    else groups.set(generic.id, { generic, category, pendingCount, records: [record] })
  }
  return [...groups.values()]
}

export const canAct = (record: Classification) => record.status === 'pending'
export function confirmable(records: Classification[]): Classification[] {
  return records.filter((record) => canAct(record) && record.actions.can_confirm)
}
export function confirmItems(records: Classification[]): ClassificationConfirmItem[] {
  return records.map((record) => ({ id: record.id, version: record.version }))
}
/** The mass confirmation takes at most 100 records: larger sets go as consecutive requests. */
export function batches<T>(items: T[], size = classificationConfirmLimit): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

export const isServiceGeneric = (name: string) => name.trim().toLocaleLowerCase('ru-RU') === 'не разобрано'
/** «Выбрать другой» never offers the service «Не разобрано» nor the generic product already suggested. */
export function chooseOptions(generics: GenericProduct[], record: Pick<Classification, 'suggested'>): GenericProduct[] {
  return generics.filter((item) => !isServiceGeneric(item.name) && item.id !== record.suggested.generic.id)
}
/** Search text as the catalog API takes it: nothing, or 2–100 characters. `short` — one character, not sent. */
export function searchQuery(text: string): { q?: string; short: boolean } {
  const value = text.trim()
  const length = [...value].length
  return length === 0 ? { short: false } : length < 2 ? { short: true } : { q: value, short: false }
}

export { runActive, runFinished, stateActive } from './list-sync'
export function canRequestRun(state: ClassificationState): boolean {
  return state.unclassified_count > 0 && !runActive(state.run)
}
/** `POST runs/` answered: show its run and worker at once, the counters wait for the next read. */
export function applyRunRequest(state: ClassificationState, answer: ClassificationRunRequest): ClassificationState {
  return { ...state, run: answer.run ?? state.run, executor: answer.executor }
}
/** Records answered by the server replace their copies on the page; the page itself is read again afterwards. */
export function replaceRecords(page: Page<Classification>, records: Classification[]): Page<Classification> {
  const fresh = new Map(records.map((record) => [record.id, record]))
  return { ...page, results: page.results.map((record) => fresh.get(record.id) ?? record) }
}

/** The single open inline area of the screen: a confirmation line or the chooser of another generic product. */
export type OpenArea = { kind: 'reject' | 'choose'; id: number } | { kind: 'bulk'; genericId: number }
export const areaKey = (area: OpenArea) => area.kind === 'bulk' ? `bulk-${area.genericId}` : `${area.kind}-${area.id}`
/** An area lives only while its record or group can still be acted on. */
export function openArea(area: OpenArea | undefined, records: Classification[]): OpenArea | undefined {
  if (!area) return undefined
  if (area.kind === 'bulk') return confirmable(records.filter((record) => record.suggested.generic.id === area.genericId)).length ? area : undefined
  const record = records.find((item) => item.id === area.id)
  return record && canAct(record) && (area.kind === 'reject' ? record.actions.can_reject : record.actions.can_choose) ? area : undefined
}

/** An open area with what the person saw when it opened. */
export type Opened = { area: OpenArea; seen: string }
/** What an area acts on: the version of its record, or the records «Подтвердить все» would send. Nothing — the area cannot live. */
export function areaSeen(area: OpenArea, records: Classification[]): string | undefined {
  if (!openArea(area, records)) return undefined
  if (area.kind !== 'bulk') return String(records.find((record) => record.id === area.id)!.version)
  return confirmItems(confirmable(records.filter((record) => record.suggested.generic.id === area.genericId)))
    .map((item) => `${item.id}:${item.version}`).join(',')
}
export function openedArea(area: OpenArea, records: Classification[]): Opened | undefined {
  const seen = areaSeen(area, records)
  return seen === undefined ? undefined : { area, seen }
}
export type AreaFate = 'open' | 'changed' | 'gone'
/**
 * A read of the list never closes an area whose record is the same. A record that left the list or cannot be acted on
 * (`gone`) and a record or a group that is not what the person saw (`changed`) close it, as the refusals
 * `classification_resolved` and `classification_changed` of the action itself would.
 */
export function areaFate(opened: Opened, records: Classification[]): AreaFate {
  const now = areaSeen(opened.area, records)
  return now === opened.seen ? 'open' : now === undefined ? 'gone' : 'changed'
}
