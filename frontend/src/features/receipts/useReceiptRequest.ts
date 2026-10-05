import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { LocalApiResult } from '../../api/types'
import { createReceiptRequest } from './request'

export function useReceiptRequest<T>(load: (signal: AbortSignal) => Promise<LocalApiResult<T>>) {
  const request = useMemo(() => createReceiptRequest(load), [load])
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getSnapshot)
  useEffect(() => { request.start(); return request.stop }, [request])
  return { state, retry: request.start }
}
