import type { Executor } from './recognition-types.ts'
import type { Decimal, GenericRef, ISODateTime, NamedObject, PageParams, ProductAlias, Unit } from './types.ts'

export const classificationStatuses = ['pending', 'confirmed', 'rejected', 'superseded'] as const
export type ClassificationStatus = typeof classificationStatuses[number]
/** How a record left `pending`: by a person (`confirmed`, `other`, `rejected`), by a command or by a change outside the screen. */
export const classificationResolutions = {
  confirmed: ['confirmed', 'other'], rejected: ['rejected', 'cancelled'], superseded: ['changed', 'merged', 'product_removed'],
} as const
export type ClassificationResolution = typeof classificationResolutions[keyof typeof classificationResolutions][number]
export const classificationRunStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type ClassificationRunStatus = typeof classificationRunStatuses[number]

/** «Новая»: created by the mechanism and not yet accepted by a person. */
export type ClassificationPathItem = NamedObject & { is_new: boolean }
export type ClassificationCategory = NamedObject & { path: ClassificationPathItem[] }
export type ClassificationProduct = {
  /** Always the product the record was made for, also after it was removed. */
  id: number
  /** False — the product is gone: name, brand and package are a snapshot, `generic` is null and `aliases` is empty. */
  exists: boolean
  name: string; brand: NamedObject | null
  package: { quantity: Decimal; unit: Unit } | null
  /** Current generic product of the product; differs from the suggested one when it was changed outside the screen. */
  generic: GenericRef | null
  aliases: ProductAlias[]
  /** Pending duplicate group that absorbed the product: its card answers 404 meanwhile. */
  merge_group_id: number | null
}
export type ClassificationSuggested = {
  generic: GenericRef & { exists: boolean; is_new: boolean }
  /** Null only for damaged data: neither a live path nor a snapshot. */
  category: ClassificationCategory | null
  /** Pending records with the same suggested generic product in the whole database, not on the page. */
  pending_count: number
}
/** `run_id` and `trigger` are null after the source run was deleted. */
export type ClassificationSource = {
  run_id: number | null; trigger: string | null; provider: string; model: string; prompt_version: string; schema_version: string
}
/** A snapshot hint: the server checks the state again under its lock. */
export type ClassificationActions = { can_confirm: boolean; can_choose: boolean; can_reject: boolean }
/** «Запись»: one suggestion for one product. */
export type Classification = {
  id: number; status: ClassificationStatus; resolution: ClassificationResolution | null
  /** Confirm and reject must send the value they read. */
  version: number
  created_at: ISODateTime; resolved_at: ISODateTime | null
  product: ClassificationProduct; previous_generic: GenericRef; suggested: ClassificationSuggested
  /** What the product kept after the decision; null while pending. */
  final_generic: GenericRef | null
  source: ClassificationSource; actions: ClassificationActions
}

export type ClassificationRunProgress = { requested: number; processed: number; applied: number; unknown: number; skipped: number }
/** «Запуск». `error.message` is a server text and never reaches the screen: the client translates `error.code`. */
export type ClassificationRun = {
  id: number; status: ClassificationRunStatus; trigger: string; scope: string; version: number
  created_at: ISODateTime; started_at: ISODateTime | null; finished_at: ISODateTime | null
  progress: ClassificationRunProgress
  /** Candidates left outside the run by its limit; 0 also when it was not counted. */
  remaining: number
  error: { code: string; message: string } | null
}
/** «Состояние»: `run` is the active run, else the last one, else null. */
export type ClassificationState = {
  pending_count: number; unclassified_count: number; auto_suggest: boolean; run: ClassificationRun | null; executor: Executor
}
/** Answer of `POST runs/`: `run: null` — there is nothing to classify. */
export type ClassificationRunRequest = { created: boolean; run: ClassificationRun | null; executor: Executor }
export type ClassificationConfirmMany = { confirmed: number; results: Classification[] }

export type ClassificationParams = PageParams & {
  status?: ClassificationStatus; product?: number; generic?: number; run?: number; ordering?: 'generic' | '-id'
}
export type ClassificationRunParams = PageParams & { status?: ClassificationRunStatus }
/** `generic_id` is always sent: the suggested one to confirm, another one to choose. */
export type ClassificationConfirmInput = { version: number; generic_id: number }
export type ClassificationRejectInput = { version: number }
export type ClassificationConfirmItem = { id: number; version: number }
/** The server accepts 1–100 records in one mass confirmation. */
export const classificationConfirmLimit = 100
