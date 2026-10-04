/** Own a single object URL; mounting, replacement and StrictMode cleanup are explicit. */
export function createPreview(file: File, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) {
  let url: string | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => url,
    getServerSnapshot: () => undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => { if (!url) url = urls.createObjectURL(file); listeners.forEach((listener) => listener()) },
    dispose: () => { if (url) urls.revokeObjectURL(url); url = undefined },
  }
}
