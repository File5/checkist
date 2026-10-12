import { useState } from 'react'
import { safeMediaUrl } from '../../lib/media'
import { DownloadOriginal } from '../recognition/MediaImage'
import ReceiptMedia from './ReceiptMedia'
import { Sheet } from './_tmp-foundation' /* mobile-foundation: temporary, integrator removes */

/**
 * The photo of a receipt in its header card on a phone: a thumbnail; a tap opens the full preview in a sheet with
 * «Скачать оригинал». Nothing without a safe image address.
 */
export function ReceiptPhoto({ thumb, image, download, receiptId, initialOpen = false }: {
  thumb: string | null; image: string | null; download?: string | null; receiptId: number; initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const preview = safeMediaUrl(thumb) ?? safeMediaUrl(image)
  if (!preview) return null
  const alt = `Фото чека №${receiptId}`
  return <>
    <button type="button" className="receipt-photo-thumb" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <img src={preview} alt="" loading="lazy" decoding="async" />
      <span className="receipt-visually-hidden">{alt}: открыть</span>
    </button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Фото чека">
      <ReceiptMedia url={image ?? thumb} alt={alt} />
      <DownloadOriginal url={download} />
    </Sheet>
  </>
}
