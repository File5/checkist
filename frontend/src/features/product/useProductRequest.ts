import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ApiResult } from '../../api/types'
import { createRequest } from './state'

/** Call with a useCallback loader. A changed loader gets a fresh loading snapshot immediately. */
export function useProductRequest<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  const request = useMemo(() => createRequest(load), [load])
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getServerSnapshot)
  useEffect(() => { request.run(); return request.dispose }, [request])
  return { state, retry: request.run }
}
