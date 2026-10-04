import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { LocalApiResult } from '../../api/types'
import { createPollingRequest } from './polling'

const neverActive = () => false
const alwaysAccept = () => true
export function useRequest<T>(load: (signal: AbortSignal) => Promise<LocalApiResult<T>>, active: (data: T) => boolean = neverActive, accept: (previous: T, next: T) => boolean = alwaysAccept) {
  const request = useMemo(() => createPollingRequest(load, active, accept), [load, active, accept])
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getServerSnapshot)
  useEffect(() => { request.start(); return request.dispose }, [request])
  return { state, request }
}
