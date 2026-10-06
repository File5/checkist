import { isExecutor } from './recognition-schema.ts'
import { array, bool, choice, isId, isISODateTime, named, nonNegativeInteger, nullable, object, quantity, text, unit } from './schema.ts'
import type { Guard } from './schema.ts'
import { classificationResolutions, classificationRunStatuses, classificationStatuses } from './product-classifications-types.ts'
import type {
  Classification, ClassificationActions, ClassificationCategory, ClassificationConfirmMany, ClassificationPathItem, ClassificationProduct,
  ClassificationRun, ClassificationRunProgress, ClassificationRunRequest, ClassificationSource, ClassificationState, ClassificationSuggested,
} from './product-classifications-types.ts'
import type { GenericRef, ProductAlias } from './types.ts'

const baseUnit = choice('pcs', 'kg', 'l')
const generic = object<GenericRef>({ id: isId, name: text, base_unit: baseUnit })
const alias = object<ProductAlias>({ store_name: text, raw_name: text, store_item_code: text })
const productShape = object<ClassificationProduct>({
  id: isId, exists: bool, name: text, brand: nullable(named),
  package: nullable(object<{ quantity: string; unit: string }>({ quantity, unit })),
  generic: nullable(generic), aliases: array(alias), merge_group_id: nullable(isId),
})
/** A removed product is a snapshot: no current generic product, no aliases, no duplicate group. */
const product: Guard<ClassificationProduct> = (value): value is ClassificationProduct => productShape(value) && (value.exists
  ? value.generic !== null : value.generic === null && value.aliases.length === 0 && value.merge_group_id === null)

const pathItem = object<ClassificationPathItem>({ id: isId, name: text, is_new: bool })
const categoryShape = object<ClassificationCategory>({ id: isId, name: text, path: array(pathItem) })
/** The category of the generic product is the last step of its own path. */
const category: Guard<ClassificationCategory> = (value): value is ClassificationCategory => categoryShape(value)
  && value.path.at(-1)?.id === value.id
const suggestedGeneric = object<ClassificationSuggested['generic']>({ id: isId, name: text, base_unit: baseUnit, exists: bool, is_new: bool })
const suggested = object<ClassificationSuggested>({ generic: suggestedGeneric, category: nullable(category), pending_count: nonNegativeInteger })
const source = object<ClassificationSource>({
  run_id: nullable(isId), trigger: nullable(text), provider: text, model: text, prompt_version: text, schema_version: text,
})
const actions = object<ClassificationActions>({ can_confirm: bool, can_choose: bool, can_reject: bool })
const resolutions: string[] = Object.values(classificationResolutions).flat()
const recordShape = object<Classification>({
  id: isId, status: choice(...classificationStatuses), resolution: nullable(choice(...resolutions)), version: isId,
  created_at: isISODateTime, resolved_at: nullable(isISODateTime), product, previous_generic: generic, suggested,
  final_generic: nullable(generic), source, actions,
})
/** «Запись» with a consistent lifecycle: a pending record is undecided, a decided one offers no actions. */
export const isClassification: Guard<Classification> = (value): value is Classification => {
  if (!recordShape(value)) return false
  if (value.status === 'pending') return value.resolution === null && value.resolved_at === null && value.final_generic === null
  return value.resolution !== null && (classificationResolutions[value.status] as readonly string[]).includes(value.resolution)
    && value.resolved_at !== null && !Object.values(value.actions).some(Boolean)
}

const progress = object<ClassificationRunProgress>({
  requested: nonNegativeInteger, processed: nonNegativeInteger, applied: nonNegativeInteger, unknown: nonNegativeInteger, skipped: nonNegativeInteger,
})
const runError = object<{ code: string; message: string }>({ code: text, message: text })
const runShape = object<ClassificationRun>({
  id: isId, status: choice(...classificationRunStatuses), trigger: text, scope: text, version: isId,
  created_at: isISODateTime, started_at: nullable(isISODateTime), finished_at: nullable(isISODateTime),
  progress, remaining: nonNegativeInteger, error: nullable(runError),
})
/** «Запуск»: only a failed run carries an error; a queued one has not started. */
export const isClassificationRun: Guard<ClassificationRun> = (value): value is ClassificationRun => runShape(value)
  && (value.status === 'failed') === (value.error !== null)
  && (value.status !== 'queued' || (value.started_at === null && value.finished_at === null))

export const isClassificationState = object<ClassificationState>({
  pending_count: nonNegativeInteger, unclassified_count: nonNegativeInteger, auto_suggest: bool,
  run: nullable(isClassificationRun), executor: isExecutor,
})
const runRequestShape = object<ClassificationRunRequest>({ created: bool, run: nullable(isClassificationRun), executor: isExecutor })
/** A created run always comes with the answer; `run: null` means nothing was queued. */
export const isClassificationRunRequest: Guard<ClassificationRunRequest> = (value): value is ClassificationRunRequest =>
  runRequestShape(value) && (!value.created || value.run !== null)
const confirmManyShape = object<ClassificationConfirmMany>({ confirmed: nonNegativeInteger, results: array(isClassification) })
/** Mass confirmation is all or nothing: every answered record is confirmed, in the order of ids. */
export const isClassificationConfirmMany: Guard<ClassificationConfirmMany> = (value): value is ClassificationConfirmMany =>
  confirmManyShape(value) && value.confirmed === value.results.length
  && value.results.every((record, index) => record.status === 'confirmed' && (index === 0 || value.results[index - 1].id < record.id))
