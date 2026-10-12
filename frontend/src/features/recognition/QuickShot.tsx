import { useRef } from 'react'
import { navigate } from '../../navigation'
import { uploadLabels } from './labels'
import { setQuickShot } from './quick-shot'
import './QuickShot.css'

/** The main path on a phone: one press opens the camera, the shot goes to the upload page and is sent there.
 * The camera opens from this click: iOS Safari would not open it from the next page. */
export default function QuickShot() {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className="ck-quick-shot" onClick={() => input.current?.click()}>{uploadLabels.camera}</button>
    <input ref={input} className="ck-quick-shot-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setQuickShot(file)
        navigate('/receipts/upload')
      }} />
  </>
}
