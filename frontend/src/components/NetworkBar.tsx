import { useEffect, useState } from 'react'
import { inFlightCount, subscribe } from '../api/activity'
import { watchActivity } from './network-bar'

/** A thin bar at the very top of the window while the app waits for the server longer than a moment (network-bar.ts).
 * Hidden from a screen reader: the waiting blocks say it with `aria-busy` and their words. */
export default function NetworkBar() {
  const [visible, setVisible] = useState(false)
  useEffect(() => watchActivity({ count: inFlightCount, subscribe }, setVisible), [])
  return visible ? <div className="ck-network-bar" aria-hidden="true" /> : null
}
