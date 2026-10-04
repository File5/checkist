import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ApiResult } from '../../api/types'
import { createCatalogRequest } from './catalog-request'

/** Use a stable loader callback keyed by the request's URL parameters. */
export function useCatalogRequest<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  const request = useMemo(() => createCatalogRequest(load), [load])
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getSnapshot)
  useEffect(() => {
    request.start()
    return request.stop
  }, [request])
  return { state, retry: request.start }
}
