/**
 * Writes wait for «Я». No React and no imports: `local.ts` depends on it.
 *
 * The application starts as the person remembered on the device (`session/store.ts`) and reads `GET /api/me/` in the
 * background. Only a successful answer of the server confirms that person. Until then nothing is written: a save
 * pressed meanwhile asks for «Я» again and waits for it (at most `WRITE_WAIT_MS`), then
 *  - `go` — the server knows the remembered person: the write goes with the token of that session;
 *  - `stop` — a guest or another person: the write is dropped (`aborted`), what was typed for the remembered person
 *    never reaches another account;
 *  - `retry` — «Я» could not be read (no network, a server failure, the deadline): nothing is sent, the caller gets
 *    the ordinary network failure, and the writes stay held for the next attempt.
 */
export type WriteOutcome = 'go' | 'stop' | 'retry'

/** How long a write waits for «Я»: the deadline of an ordinary request. */
export const WRITE_WAIT_MS = 15_000

let held: { promise: Promise<WriteOutcome>; release: (outcome: WriteOutcome) => void } | undefined
let wake: (() => void) | undefined

/** From now on writes wait. A second call changes nothing. */
export function holdWrites(): void {
  if (held) return
  let release!: (outcome: WriteOutcome) => void
  const promise = new Promise<WriteOutcome>((resolve) => { release = resolve })
  held = { promise, release }
}

/** Settles the waiting writes. `go` and `stop` also open the gate for later writes; `retry` keeps it closed. */
export function releaseWrites(outcome: WriteOutcome = 'go'): void {
  const current = held
  if (!current) return
  held = undefined
  if (outcome === 'retry') holdWrites()
  current.release(outcome)
}

export function writesHeld(): boolean {
  return held !== undefined
}

/** Who reads «Я» again when a write starts waiting: the session store. */
export function onWriteWaiting(listener: (() => void) | undefined): void {
  wake = listener
}

/** `undefined` — a write may go now (no waiting, not even a microtask); otherwise how it ends once «Я» answered.
 * A caller that gives up meanwhile gets `aborted`. */
export function waitForWrites(signal?: AbortSignal): Promise<WriteOutcome | 'aborted'> | undefined {
  const current = held
  if (!current) return undefined
  if (signal?.aborted) return Promise.resolve('aborted')
  try { wake?.() } catch { /* the write still waits for its deadline */ }
  return new Promise((resolve) => {
    let done = false
    const finish = (outcome: WriteOutcome | 'aborted') => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(outcome)
    }
    const abort = () => finish('aborted')
    const timer = setTimeout(() => finish('retry'), WRITE_WAIT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    void current.promise.then(finish)
  })
}
