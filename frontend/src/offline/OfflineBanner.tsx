import { useSyncExternalStore } from 'react'
import { getOfflineStatus, offlineMessage, subscribeOfflineStatus } from './status'
import type { OfflineStatus } from './status'
import './Offline.css'

/** The words of the banner; a separate view for the markup test. */
export function OfflineBannerView({ status }: { status: OfflineStatus }) {
  const message = offlineMessage(status)
  if (!message) return null
  return <div className="offline-banner" role="status">
    <strong>{message.title}.</strong> {message.detail}
  </div>
}

/** A small strip at the top while there is no network or the API answered from the phone. */
export default function OfflineBanner() {
  const status = useSyncExternalStore(subscribeOfflineStatus, getOfflineStatus, getOfflineStatus)
  return <OfflineBannerView status={status} />
}
