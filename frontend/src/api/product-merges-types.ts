import type {
  CurrencyCode, Decimal, GenericRef, ISODate, ISODateTime, NamedObject, PageParams, ProductAlias, StoreBrief, Unit,
} from './types.ts'

export const mergeStatuses = ['pending', 'confirmed', 'cancelled'] as const
export type MergeStatus = typeof mergeStatuses[number]
export type MergeMemberRole = 'target' | 'source'
export type MergeMemberState = 'active' | 'excluded'
/** Facts that may differ between records. `attributes` conflicts are visible only here, never in a member. */
export const mergeConflictFields = ['generic', 'brand', 'package', 'gtin', 'model', 'attributes'] as const
export type MergeConflictField = typeof mergeConflictFields[number]

/** Record of a brief group. Counts and dates follow the journal: the original ownership. */
export type MergeMemberBrief = {
  product_id: number; role: MergeMemberRole; state: MergeMemberState
  /** False after confirmation deleted the product: name and facts are a snapshot. */
  exists: boolean
  name: string; brand: NamedObject | null; model: string; gtin: string
  package: { quantity: Decimal; unit: Unit } | null
  generic: GenericRef
  /** False while the generic product is the service «Не разобрано». */
  classified: boolean
  lines_count: number; first_purchased_on: ISODate | null; last_purchased_on: ISODate | null
}
export type MergeMember = MergeMemberBrief & { aliases: ProductAlias[] }
export type MergeConflict = { field: MergeConflictField; product_ids: number[] }
export type MergeActions = { can_confirm: boolean; can_cancel: boolean; can_exclude: boolean }
type MergeGroupBase = {
  id: number; status: MergeStatus
  /** Grows when the member set changes; confirm and exclude must send the value they read. */
  version: number
  created_at: ISODateTime; resolved_at: ISODateTime | null; target_product_id: number
  lines_count: number; new_lines_count: number; actions: MergeActions
}
/** List projection: members have no aliases, conflicts are only flagged. */
export type MergeGroupBrief = MergeGroupBase & { members: MergeMemberBrief[]; has_conflicts: boolean }
/** «Группа»: detail and every mutation response. */
export type MergeGroup = MergeGroupBase & { members: MergeMember[]; conflicts: MergeConflict[] }
/** Purchase of a group. `origin_product_id: null` — the line came after the merge. */
export type MergeLine = {
  line_id: number; receipt_id: number; position: number; purchased_on: ISODate; store: StoreBrief
  name: string; quantity: Decimal; unit: Unit; unit_price: Decimal; amount: Decimal; discount_amount: Decimal
  currency: CurrencyCode; origin_product_id: number | null
}
export type MergeDetectResult = { created: number; extended: number; group_ids: number[] }

export type MergeGroupParams = PageParams & { status?: MergeStatus; product?: number }
/** Product id whose value of the disputed field wins. */
export type MergeResolutions = Partial<Record<MergeConflictField, number>>
/** `name_product_id` is omitted, never null: the server rejects null. */
export type MergeConfirmInput = { version: number; target_product_id: number; name_product_id?: number; resolutions?: MergeResolutions }
export type MergeExcludeInput = { version: number; product_id: number }
