import { getProductClassification } from '../../api/product-classifications'
import type { Classification, ClassificationState } from '../../api/product-classifications'
import type { LocalApiResult, Page } from '../../api/types'
import type { createPollingRequest } from '../recognition/polling'
import { keepsArea } from './actions'
import type { ActionLifecycle } from './actions'
import type { createReadSync } from './list-sync'
import { applyRunRequest, replaceRecords } from './state'

type Request<T> = ReturnType<typeof createPollingRequest<T>>
/** The request of one list — a filter, a product and a page — with its connection to the state. */
export type ListReads = { lists: Request<Page<Classification>>; reads: Pick<ReturnType<typeof createReadSync>, 'afterAction'> }

/**
 * What the actions of the screen do to its two requests. The state lives as long as the page; the list and the actions
 * are replaced with every filter, product and page, so an action can end when its own list is gone.
 */
export function createPageLifecycle({ states, own, shown, loadState, loadList, area }: {
  states: Request<ClassificationState>
  /** The list the actions were created for. */
  own: ListReads
  /** The list shown now: not `own` after the person went on while a POST was in flight. */
  shown: () => ListReads
  loadState: (signal: AbortSignal) => Promise<LocalApiResult<ClassificationState>>
  loadList: (signal: AbortSignal) => Promise<LocalApiResult<Page<Classification>>>
  area: {
    close: () => void
    /** The kept area goes on from the records as the action left them. */
    keep: (records: Classification[]) => void
    /** The server refused the chosen option: the options of «Выбрать другой» are read again. */
    reloadOptions: () => void
  }
}): ActionLifecycle {
  const { lists, reads } = own
  const replace = (records: Classification[]) => {
    const current = lists.getSnapshot()
    if (records.length && current.kind === 'ok') lists.setData(replaceRecords(current.data, records))
  }
  // Both requests are read again once: their answers are a new beginning, not a change made elsewhere.
  const resume = () => { reads.afterAction(); states.resume(); lists.resume() }
  return {
    pause: () => { states.pause(); lists.pause() },
    // The answered records are shown at once; the counters, the groups and the list are then read again.
    success: (outcome) => {
      replace(outcome.records)
      const current = states.getSnapshot()
      if (outcome.run && current.kind === 'ok') states.setData(applyRunRequest(current.data, outcome.run))
      area.close()
      resume()
    },
    failure: (error, action, records) => {
      replace(records)
      if (!keepsArea(error, action)) area.close()
      else {
        const current = lists.getSnapshot()
        if (current.kind === 'ok') area.keep(current.data.results)
        if (action.type === 'choose' && error.reason !== 'classification_busy' && error.reason !== 'csrf_failed') area.reloadOptions()
      }
      resume()
    },
    reread: async (action, signal) => {
      if (action.type === 'run') {
        const result = await loadState(signal)
        if (result.kind === 'ok') states.setData(result.data)
      } else if (action.type === 'confirmAll') {
        const result = await loadList(signal)
        if (result.kind === 'ok') lists.setData(result.data)
      } else {
        const result = await getProductClassification(action.id, { signal })
        if (result.kind === 'ok') replace([result.data])
      }
    },
    // The state outlives the actions: left paused, it would never be read, polled or retried again.
    release: resume,
    // The POST may have been saved after the reads `release` started: the state and the list shown now are read once more.
    settled: () => {
      const now = shown()
      now.reads.afterAction()
      states.queueRefresh()
      now.lists.queueRefresh()
    },
  }
}
