import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { LocalApiResult } from '../../api/types'
import { createReceiptRequest } from '../receipts/request'
import type { ReceiptRequestState } from '../receipts/request'

export type StatsRequestState<T> = { kind: 'idle' } | ReceiptRequestState<T>
type Loader<T> = (signal: AbortSignal) => Promise<LocalApiResult<T>>

const idle = { kind: 'idle' } as const
const getIdle = () => idle
const subscribeNothing = () => () => {}
const nothing = () => {}

/** One independent block. Call with a memoized loader; `null` means there is nothing to ask yet and no request is made. */
export function useStatsRequest<T>(load: Loader<T> | null): { state: StatsRequestState<T>; retry: () => void } {
  const request = useMemo(() => (load ? createReceiptRequest(load) : null), [load])
  const state = useSyncExternalStore<StatsRequestState<T>>(
    request?.subscribe ?? subscribeNothing, request?.getSnapshot ?? getIdle, request?.getSnapshot ?? getIdle)
  useEffect(() => {
    if (!request) return undefined
    request.start()
    return request.stop
  }, [request])
  return { state, retry: request?.start ?? nothing }
}
