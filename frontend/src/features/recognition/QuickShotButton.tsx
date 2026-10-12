import { uploadLabels } from './labels'
import { useQuickShot } from './QuickShot'

/** A button for the same press in another place, such as the big button of «Главная»; the flow behind it is
 * useQuickShot, the same as in the «＋» sheet of the main menu. */
export default function QuickShot({ className, label = uploadLabels.camera }: { className: string; label?: string }) {
  const shot = useQuickShot()
  return <>
    <button type="button" className={className} onClick={shot.open}>{label}</button>
    {shot.field}
  </>
}
