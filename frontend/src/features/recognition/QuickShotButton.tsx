import { uploadLabels } from './labels'
import { useQuickShot } from './QuickShot'
import type { QuickShotSource } from './QuickShot'

/** A button for the same press in another place, such as the big buttons of «Главная»; the flow behind it is
 * useQuickShot, the same as in the «＋» sheet of the main menu. */
export default function QuickShot({ className, label, source = 'camera' }: { className: string; label?: string; source?: QuickShotSource }) {
  const shot = useQuickShot(source)
  return <>
    <button type="button" className={className} onClick={shot.open}>{label ?? (source === 'camera' ? uploadLabels.camera : uploadLabels.gallery)}</button>
    {shot.field}
  </>
}
