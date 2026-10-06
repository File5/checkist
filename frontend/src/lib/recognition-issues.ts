import { publicPointer } from '../api/recognition-schema.ts'
import type { IssueContext, IssueSeverity, ReceiptImageStatus, RecognitionIssue } from '../api/recognition-types.ts'
import { areaLabels, entityLabels, reasonLabels } from './recognition-labels.ts'
import type { IssueReason } from './recognition-labels.ts'

export type IssueEntity = 'receipt' | 'line' | 'tax' | 'discount' | 'geometry' | 'unknown'
/** One issue reduced to closed vocabulary. `legacy` marks an answer of a server without reason/severity/context. */
export type IssueView = {
  severity: IssueSeverity; reason: IssueReason; entity: IssueEntity
  index: number | null; position: number | null; attribute: string | null; legacy: boolean
}
export type IssueGroup = {
  key: string; severity: IssueSeverity; reason: IssueReason; entity: IssueEntity; attribute: string | null
  count: number; title: string; explanation: string | null; locations: string[]
}

const collections: Record<string, IssueEntity> = { lines: 'line', discounts: 'discount', taxes: 'tax' }
const geometry: Record<string, string | null> = { geometry: null, bbox: 'bbox', quad: 'quad', rotation_degrees: 'rotation_degrees', clipped: 'clipped' }
const entities: readonly string[] = ['receipt', 'line', 'tax', 'discount', 'geometry', 'unknown']
const closedLinePointer = /^\/lines\/([0-9]{1,4})\/([a-z0-9_]+)(?:\/[a-z0-9_]+){0,3}$/
const closedPointer = /^\/[a-z0-9_]+(?:\/[a-z0-9_]+){0,3}$/
const severityOrder: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 }

/** Same parsing as issue_context in backend/api/recognition_serialization.py; the client has no DTO, so position is null. */
export function fieldContext(field: unknown): IssueContext {
  const context: IssueContext = { entity: 'unknown', index: null, position: null, attribute: 'unknown' }
  if (typeof field !== 'string') return context
  const parts = field.slice(1).split('/')
  const line = closedLinePointer.exec(field)
  if (publicPointer.test(field)) {
    if (Object.hasOwn(collections, parts[0])) {
      context.entity = collections[parts[0]]
      context.index = parts.length > 1 ? Number(parts[1]) : null
      context.attribute = parts.length > 2 ? parts[2] === 'raw_name' ? 'name' : parts[2] : null
    } else if (Object.hasOwn(geometry, parts[0])) {
      context.entity = 'geometry'
      context.attribute = geometry[parts[0]]
    } else {
      context.entity = 'receipt'
      context.attribute = field === '/currency_code' ? 'currency' : parts.join('_') || null
    }
  } else if (line) {
    context.entity = 'line'
    context.index = Number(line[1])
    context.attribute = line[2] === 'product_hint' ? 'product' : 'unknown'
  } else if (closedPointer.test(field)) {
    context.entity = 'receipt'
    context.attribute = 'receipt_metadata'
  }
  return context
}

/** New answer: closed vocabulary with unknown for unlisted slugs. Old answer: fallback from code, field and crop status. */
export function issueView(issue: RecognitionIssue, status: ReceiptImageStatus): IssueView {
  const legacy = issue.reason === undefined || issue.severity === undefined || issue.context === undefined
  const reason = legacy ? issue.code : issue.reason!
  const context = legacy ? fieldContext(issue.field) : issue.context!
  return {
    severity: legacy ? status === 'needs_review' || status === 'failed' ? 'error' : 'warning' : issue.severity!,
    reason: Object.hasOwn(reasonLabels, reason) ? reason as IssueReason : 'unknown',
    entity: entities.includes(context.entity) ? context.entity as IssueEntity : 'unknown',
    index: context.index, position: context.position,
    attribute: context.attribute === null || Object.hasOwn(areaLabels, context.attribute) ? context.attribute : 'unknown',
    legacy,
  }
}

/** Russian plural: 1 → one, 2–4 → few, 5+ and 11–14 → many. */
export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100, units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}

// An old server hides every internal cause behind invalid_value, so its own label would mislead.
function reasonLabel(view: Pick<IssueView, 'reason' | 'legacy'>): string {
  return reasonLabels[view.legacy && view.reason === 'invalid_value' ? 'unknown' : view.reason]
}
function areaLabel(view: Pick<IssueView, 'entity' | 'attribute'>): string {
  return (view.attribute === null ? undefined : areaLabels[view.attribute]) ?? entityLabels[view.entity] ?? ''
}
function numbers(values: number[]): string {
  return [...new Set(values)].sort((a, b) => a - b).join(', ')
}
function locations(entity: IssueEntity, items: IssueView[]): string[] {
  const indexed = items.filter((item) => item.index !== null)
  if (entity === 'tax') return indexed.length > 0 ? [`Налоговые итоги №: ${numbers(indexed.map((item) => item.index! + 1))}`] : []
  if (entity !== 'line' && entity !== 'discount') return []
  const name = entity === 'line' ? 'Строки' : 'Скидки'
  const printed = items.filter((item) => item.position !== null).map((item) => item.position!)
  const recognized = indexed.filter((item) => item.position === null).map((item) => item.index! + 1)
  return [
    ...(printed.length > 0 ? [`${name}: ${numbers(printed)}`] : []),
    ...(recognized.length > 0 ? [`${name} распознавания №: ${numbers(recognized)}`] : []),
  ]
}
function describe(first: IssueView, items: IssueView[]): Pick<IssueGroup, 'title' | 'explanation'> {
  const count = items.length
  const indexed = items.every((item) => item.index !== null)
  if (first.reason === 'optional_omitted') {
    if (first.entity === 'line' && first.attribute === 'tax_rate' && indexed) return {
      title: `НДС не использован в ${count} ${plural(count, 'строке', 'строках', 'строках')}`,
      explanation: 'Распознавание не подтвердило чтение ставки, поэтому ставка не сохранена. Остальные данные строк сохранены.',
    }
    if (first.entity === 'tax' && indexed) return {
      title: plural(count, `Пропущен ${count} налоговый итог`, `Пропущены ${count} налоговых итога`, `Пропущено ${count} налоговых итогов`),
      explanation: 'Налоговый итог не сохранён: ставка не подтверждена или суммы не сходятся.',
    }
    if (first.attribute === 'receipt_metadata') return {
      title: plural(count, `Не прочитан ${count} реквизит`, `Не прочитаны ${count} реквизита`, `Не прочитано ${count} реквизитов`),
      explanation: 'Необязательные реквизиты чека не прочитаны уверенно и не сохранены. Значения не показываются.',
    }
  }
  const area = areaLabel(first)
  return { title: `${reasonLabel(first)}${area && ` · ${area}`}${count > 1 ? ` (${count})` : ''}`, explanation: null }
}

// The server does not fix the order of issues, so the three omission groups get their own places; 3 means any other group.
function knownOrder(group: Pick<IssueGroup, 'reason' | 'entity' | 'attribute'>): number {
  if (group.reason !== 'optional_omitted') return 3
  if (group.entity === 'line' && group.attribute === 'tax_rate') return 0
  if (group.entity === 'tax') return 1
  return group.attribute === 'receipt_metadata' ? 2 : 3
}

/** Groups by (severity, reason, entity, attribute): error, warning, info; inside a block line tax rates,
 * tax totals and requisites of optional_omitted go first, the rest by first occurrence.
 */
export function groupIssues(issues: RecognitionIssue[], status: ReceiptImageStatus): IssueGroup[] {
  const groups = new Map<string, IssueView[]>()
  for (const issue of issues) {
    const view = issueView(issue, status)
    const key = [view.severity, view.reason, view.entity, view.attribute ?? '', view.legacy ? 'legacy' : ''].join('|')
    groups.set(key, [...(groups.get(key) ?? []), view])
  }
  return [...groups].map(([key, items]) => {
    const [first] = items
    return {
      key, severity: first.severity, reason: first.reason, entity: first.entity, attribute: first.attribute,
      count: items.length, ...describe(first, items), locations: locations(first.entity, items),
    }
  }).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || knownOrder(a) - knownOrder(b))
}
