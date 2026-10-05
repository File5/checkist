import type {
  MergeConfirmInput, MergeConflict, MergeConflictField, MergeGroup, MergeGroupBrief, MergeMember, MergeResolutions, MergeStatus,
} from '../../api/product-merges'
import type { LocalApiFailure } from '../../api/types'
import type { MergesQuery } from '../../navigation'

/** What the person chose on the group screen. Nothing here is sent until «Подтвердить слияние». */
export type MergeSelection = {
  target: number
  /** Record whose name the kept product takes; absent — the name is not changed. */
  name?: number
  resolutions: MergeResolutions
}

export const activeMembers = <T extends { state: MergeMember['state'] }>(members: T[]) => members.filter((member) => member.state === 'active')

export function initialSelection(group: Pick<MergeGroup, 'target_product_id'>): MergeSelection {
  return { target: group.target_product_id, resolutions: {} }
}

/** Drops every choice the freshly read group no longer offers. */
export function normalizeSelection(group: MergeGroup, selection: MergeSelection): MergeSelection {
  const ids = new Set(activeMembers(group.members).map((member) => member.product_id))
  const target = ids.has(selection.target) ? selection.target : group.target_product_id
  const resolutions: MergeResolutions = {}
  for (const conflict of group.conflicts) {
    const chosen = selection.resolutions[conflict.field]
    if (chosen !== undefined && conflict.product_ids.includes(chosen) && ids.has(chosen)) resolutions[conflict.field] = chosen
  }
  const name = selection.name !== undefined && selection.name !== target && ids.has(selection.name) ? selection.name : undefined
  return { target, ...(name !== undefined && { name }), resolutions }
}

export function selectTarget(selection: MergeSelection, target: number): MergeSelection {
  // The kept record already owns its name: choosing it as the source means «не менять».
  return selectName({ ...selection, target }, selection.name)
}
export function selectName(selection: MergeSelection, name: number | undefined): MergeSelection {
  const { target, resolutions } = selection
  return { target, ...(name !== undefined && name !== target && { name }), resolutions }
}
export function selectResolution(selection: MergeSelection, field: MergeConflictField, productId: number): MergeSelection {
  return { ...selection, resolutions: { ...selection.resolutions, [field]: productId } }
}

/** Disputed fields still waiting for a decision; confirmation stays unavailable while any is left. */
export function missingResolutions(group: Pick<MergeGroup, 'conflicts'>, selection: MergeSelection): MergeConflictField[] {
  return group.conflicts.map((conflict) => conflict.field).filter((field) => selection.resolutions[field] === undefined)
}

export function canConfirm(group: MergeGroup, selection: MergeSelection): boolean {
  return group.status === 'pending' && group.actions.can_confirm && missingResolutions(group, selection).length === 0
}

/** Body of confirm: the version of the last read group and only the documented keys. */
export function confirmInput(group: MergeGroup, selection: MergeSelection): MergeConfirmInput {
  const chosen = normalizeSelection(group, selection)
  const resolutions = Object.keys(chosen.resolutions).length ? { resolutions: chosen.resolutions } : {}
  return {
    version: group.version, target_product_id: chosen.target,
    ...(chosen.name !== undefined && { name_product_id: chosen.name }), ...resolutions,
  }
}

/** Fields to highlight after a refusal: disputed facts, plus `name` when the result collides with another product. */
export function refusedFields(error: LocalApiFailure | undefined): string[] {
  if (!error || (error.reason !== 'merge_conflict' && error.reason !== 'invalid_parameter')) return []
  return (error.fields ?? []).map((field) => field.replace(/^resolutions\./, ''))
}

export function conflictOptions(group: MergeGroup, conflict: MergeConflict): MergeMember[] {
  return activeMembers(group.members).filter((member) => conflict.product_ids.includes(member.product_id))
}

export function apiStatus(query: MergesQuery): MergeStatus | undefined {
  return query.status === 'all' ? undefined : query.status ?? 'pending'
}

/** Marks for the catalog and the product card. */
export type PendingMark = { groupId: number; records: number }
export type MergedHint = { groupId: number; pending: boolean; target: { id: number; name: string } }

/** Kept products of pending groups: product id → its group. */
export function pendingTargets(groups: MergeGroupBrief[]): Map<number, PendingMark> {
  const marks = new Map<number, PendingMark>()
  for (const group of groups) {
    if (group.status !== 'pending' || marks.has(group.target_product_id)) continue
    marks.set(group.target_product_id, { groupId: group.id, records: activeMembers(group.members).length })
  }
  return marks
}

/** The product id was absorbed: where its purchases live now. */
export function mergedHint(groups: MergeGroupBrief[], productId: number): MergedHint | undefined {
  for (const group of groups) {
    if (group.status === 'cancelled') continue
    const member = group.members.find((item) => item.product_id === productId)
    const target = group.members.find((item) => item.product_id === group.target_product_id)
    if (!member || !target || member.role !== 'source' || member.state !== 'active') continue
    return { groupId: group.id, pending: group.status === 'pending', target: { id: target.product_id, name: target.name } }
  }
}
