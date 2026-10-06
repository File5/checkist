import { amount, array, bool, choice, country, currency, isId, isISODate, isISODateTime, named, nonNegativeInteger, nullable, object, price, quantity, text, unit } from './schema.ts'
import type { Guard } from './schema.ts'
import { mergeConflictFields, mergeStatuses } from './product-merges-types.ts'
import type {
  MergeActions, MergeConflict, MergeDetectResult, MergeGroup, MergeGroupBrief, MergeLine, MergeMember, MergeMemberBrief,
} from './product-merges-types.ts'
import type { GenericRef, ProductAlias, StoreBrief } from './types.ts'

const generic = object<GenericRef>({ id: isId, name: text, base_unit: choice('pcs', 'kg', 'l') })
const alias = object<ProductAlias>({ store_name: text, raw_name: text, store_item_code: text })
const memberShape = {
  product_id: isId, role: choice('target', 'source'), state: choice('active', 'excluded'), exists: bool,
  name: text, brand: nullable(named), model: text, gtin: text,
  package: nullable(object<{ quantity: string; unit: string }>({ quantity, unit })),
  generic, classified: bool, lines_count: nonNegativeInteger,
  first_purchased_on: nullable(isISODate), last_purchased_on: nullable(isISODate),
}
/** Journal dates exist exactly when the record has journal lines. */
function journal(member: MergeMemberBrief): boolean {
  const { first_purchased_on: first, last_purchased_on: last } = member
  return member.lines_count === 0 ? first === null && last === null : first !== null && last !== null && first <= last
}
const briefMemberShape = object<MergeMemberBrief>(memberShape)
const memberWithAliases = object<MergeMember>({ ...memberShape, aliases: array(alias) })
export const isMergeMemberBrief: Guard<MergeMemberBrief> = (value): value is MergeMemberBrief => briefMemberShape(value) && journal(value)
export const isMergeMember: Guard<MergeMember> = (value): value is MergeMember => memberWithAliases(value) && journal(value)

const actions = object<MergeActions>({ can_confirm: bool, can_cancel: bool, can_exclude: bool })
const conflict = object<MergeConflict>({ field: choice(...mergeConflictFields), product_ids: array(isId) })
const groupShape = {
  id: isId, status: choice(...mergeStatuses), version: isId, created_at: isISODateTime, resolved_at: nullable(isISODateTime),
  target_product_id: isId, lines_count: nonNegativeInteger, new_lines_count: nonNegativeInteger, actions,
}
type GroupCore = Pick<MergeGroupBrief, 'status' | 'resolved_at' | 'target_product_id' | 'lines_count' | 'new_lines_count' | 'actions' | 'members'>
/** Rules common to both projections: ordered unique members and a consistent lifecycle. */
function consistent(group: GroupCore): boolean {
  const ids = group.members.map((member) => member.product_id)
  const pending = group.status === 'pending'
  return ids.every((id, index) => index === 0 || ids[index - 1] < id)
    && ids.includes(group.target_product_id)
    && pending === (group.resolved_at === null)
    && group.new_lines_count <= group.lines_count
    && (pending || (group.new_lines_count === 0 && !Object.values(group.actions).some(Boolean)))
}
const briefShape = object<MergeGroupBrief>({ ...groupShape, members: array(isMergeMemberBrief), has_conflicts: bool })
export const isMergeGroupBrief: Guard<MergeGroupBrief> = (value): value is MergeGroupBrief => briefShape(value)
  && consistent(value) && (value.status === 'pending' || !value.has_conflicts)
const fullShape = object<MergeGroup>({ ...groupShape, members: array(isMergeMember), conflicts: array(conflict) })
export const isMergeGroup: Guard<MergeGroup> = (value): value is MergeGroup => {
  if (!fullShape(value) || !consistent(value)) return false
  if (value.status !== 'pending' && value.conflicts.length) return false
  const ids = new Set(value.members.map((member) => member.product_id))
  return new Set(value.conflicts.map((item) => item.field)).size === value.conflicts.length
    // A conflict names at least two different records of this very group.
    && value.conflicts.every((item) => item.product_ids.length >= 2
      && new Set(item.product_ids).size === item.product_ids.length && item.product_ids.every((id) => ids.has(id)))
}

const storeBrief = object<StoreBrief>({ id: isId, name: text, city: text, country })
export const isMergeLine = object<MergeLine>({
  line_id: isId, receipt_id: isId, position: nonNegativeInteger, purchased_on: isISODate, store: storeBrief,
  name: text, quantity, unit, unit_price: price, amount, discount_amount: amount, currency, origin_product_id: nullable(isId),
})
const detectShape = object<MergeDetectResult>({ created: nonNegativeInteger, extended: nonNegativeInteger, group_ids: array(isId) })
export const isMergeDetectResult: Guard<MergeDetectResult> = (value): value is MergeDetectResult => detectShape(value)
  && new Set(value.group_ids).size === value.group_ids.length
