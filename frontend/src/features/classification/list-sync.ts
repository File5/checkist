// Type-only imports: the proxy check loads this file in Node as it is.
import type { Classification, ClassificationRun, ClassificationState } from '../../api/product-classifications'
import type { Page } from '../../api/types'
import type { ClassificationQuery } from '../../navigation'

export const runActive = (run: ClassificationRun | null | undefined) => run?.status === 'queued' || run?.status === 'running'
export const stateActive = (state: ClassificationState) => runActive(state.run)
/** The run seen as active is not active any more. */
export function runFinished(previous: ClassificationState | undefined, next: ClassificationState): boolean {
  return runActive(previous?.run) && !runActive(next.run)
}

/**
 * Two reads of the state differ in what the lists show: a batch was applied, a record was decided or the run ended.
 * The server applies suggestions after every batch, so the run does not have to end; `queued → running` alone changes nothing.
 */
export function listOutdated(previous: ClassificationState | undefined, next: ClassificationState): boolean {
  if (!previous) return false
  if (previous.pending_count !== next.pending_count || runFinished(previous, next)) return true
  const before = previous.run
  const after = next.run
  if (!after) return false
  // Another run is new work only when it has already processed something.
  if (before?.id !== after.id) return after.progress.processed > 0
  return before.progress.processed !== after.progress.processed || before.progress.applied !== after.progress.applied
}

type Filter = Pick<ClassificationQuery, 'status' | 'product'>
/**
 * Whether a list of `count` records can be true together with «Ожидают подтверждения» of the state: all pending records
 * are exactly that many, the pending ones of one product are not more, all records are not fewer. Decided records say nothing.
 */
export function countsAgree(state: Pick<ClassificationState, 'pending_count'>, count: number, filter: Filter): boolean {
  if (filter.status === undefined) return filter.product === undefined ? count === state.pending_count : count <= state.pending_count
  return filter.status !== 'all' || filter.product !== undefined || count >= state.pending_count
}

export type ReadSide = 'state' | 'list'
/** Data of a request and whether its next read is under way. */
export type Read<T> = { data: T; refreshing: boolean }
export type ReadSync = {
  state?: ClassificationState; list?: Page<Classification>
  /** A disagreement of the counts and the sides already read again because of it: at most one read of each. */
  asked?: { key: string; sides: ReadSide[] }
  /** An action has just restarted both reads: their answers are a new beginning, not a change to react to. */
  hold?: boolean
}
/** Memory after an action: both requests are being read again anyway. */
export const afterAction: ReadSync = { hold: true }

/**
 * «Нужно перечитать»: called with every published state of the two independent requests. The list is read again when
 * the state shows new work of a batch or a decision made elsewhere; when the counts of the two cannot both be true,
 * the side read earlier is read again, then once the other one — never in a loop and never without a change.
 */
export function syncReads(
  memory: ReadSync, state: Read<ClassificationState> | undefined, list: Read<Page<Classification>> | undefined, filter: Filter,
): { memory: ReadSync; reread?: ReadSide } {
  if (!state) return { memory: { ...memory, list: list?.data } }
  let known = memory
  if (memory.hold) {
    if (state.refreshing || list?.refreshing) return { memory }
    known = {}
  }
  const freshState = state.data !== known.state
  const freshList = list !== undefined && list.data !== known.list
  const seen: ReadSync = { state: state.data, list: list?.data }
  if (list && freshState && listOutdated(known.state, state.data)) return { memory: seen, reread: 'list' }
  // A read under way answers by itself: the counts are compared when it is over.
  if (!list || state.refreshing || list.refreshing) return { memory: { ...seen, asked: known.asked } }
  if (countsAgree(state.data, list.data.count, filter)) return { memory: seen }
  const key = `${state.data.pending_count}:${list.data.count}`
  const sides = known.asked?.key === key ? known.asked.sides : []
  const older: ReadSide = freshList && !freshState ? 'state' : 'list'
  const reread = [older, older === 'list' ? 'state' as const : 'list' as const].find((side) => !sides.includes(side))
  return { memory: { ...seen, asked: { key, sides: reread ? [...sides, reread] : sides } }, ...(reread && { reread }) }
}

type Published<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; data: T; refreshing: boolean }
type Source<T> = { getSnapshot: () => Published<T>; subscribe: (listener: () => void) => () => void; queueRefresh: () => void }
const read = <T,>(state: Published<T>): Read<T> | undefined => state.kind === 'ok' ? { data: state.data, refreshing: state.refreshing } : undefined

/**
 * Connects the two requests of the screen: every state either of them publishes is checked at once, outside rendering.
 * A request paused for an action ignores the reread; `afterAction` is called before both are resumed.
 */
export function createReadSync(states: Source<ClassificationState>, lists: Source<Page<Classification>>, filter: Filter) {
  let memory: ReadSync = {}
  const check = () => {
    const result = syncReads(memory, read(states.getSnapshot()), read(lists.getSnapshot()), filter)
    memory = result.memory
    if (result.reread === 'list') lists.queueRefresh()
    else if (result.reread === 'state') states.queueRefresh()
  }
  return {
    start: () => {
      const stop = [states.subscribe(check), lists.subscribe(check)]
      check()
      return () => stop.forEach((unsubscribe) => unsubscribe())
    },
    afterAction: () => { memory = afterAction },
  }
}
