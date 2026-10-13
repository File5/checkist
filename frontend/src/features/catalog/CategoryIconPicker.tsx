import { useEffect, useId, useState } from 'react'
import { getCategoryIcon, setCategoryIcon } from '../../api/category-icons'
import type { CategoryIconState } from '../../api/category-icons'
import Icon from '../../components/Icon'
import { categoryIcon, categoryIconFailure as iconFailure, categoryIcons } from '../../lib/category-icons'
import { canModerate, useSession } from '../../session'

type State =
  | { kind: 'loading' } | { kind: 'error' }
  | { kind: 'ready'; icon: CategoryIconState; saving: boolean; message?: string; failed?: boolean }

export type IconChoicesProps = {
  icon: CategoryIconState; root: boolean; saving: boolean; message?: string; failed?: boolean; onChoose: (key: string | null) => void
}

/** The pictures as pressed squares, «Как у родителя» (a root: «Без значка») first with the picture it gives now. */
export function IconChoices({ icon, root, saving, message, failed, onChoose }: IconChoicesProps) {
  const id = useId()
  const choose = (key: string | null) => () => { if (!saving) onChoose(key) }
  return <section className="ck-catalog-panel ck-catalog-icons" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Значок в тратах</h2>
    <p className="ck-catalog-note">Рисуется в строках трат этой категории и подкатегорий без своего значка — у всех семей.</p>
    <div className="ck-catalog-icon-grid" role="group" aria-labelledby={`${id}-heading`} aria-busy={saving || undefined}>
      <button type="button" className="ck-catalog-icon-inherit" aria-pressed={icon.own_icon === null} aria-disabled={saving || undefined}
        onClick={choose(null)}>
        {icon.own_icon === null && <Icon name={categoryIcon(icon.icon)} />}{root ? 'Без значка' : 'Как у родителя'}
      </button>
      {categoryIcons.map(([key, label]) => <button key={key} type="button" aria-pressed={icon.own_icon === key} aria-label={label}
        title={label} aria-disabled={saving || undefined} onClick={choose(key)}><Icon name={key} /></button>)}
    </div>
    {message && <p className={failed ? 'ck-catalog-field-error' : 'ck-catalog-note'} role="status">{message}</p>}
  </section>
}

/** «Значок в тратах» of a catalog category (2026-10-13): a catalog moderator picks the picture of its spend rows. */
function Picker({ categoryId, root }: { categoryId: number; root: boolean }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    void getCategoryIcon(categoryId, { signal: controller.signal }).then((result) => {
      if (result.kind === 'aborted') return
      setState(result.kind === 'ok' ? { kind: 'ready', icon: result.data, saving: false } : { kind: 'error' })
    })
    return () => controller.abort()
  }, [categoryId])
  if (state.kind === 'loading') return null
  if (state.kind === 'error') return <p className="ck-catalog-note" role="status">Не удалось загрузить значок категории.</p>
  const ready = state
  const onChoose = (key: string | null) => {
    setState({ ...ready, saving: true, message: undefined, failed: undefined })
    void setCategoryIcon(categoryId, key, {}).then((result) => {
      if (result.kind === 'aborted') return
      setState(result.kind === 'ok' ? { kind: 'ready', icon: result.data, saving: false, message: 'Значок сохранён.' }
        : { kind: 'ready', icon: ready.icon, saving: false, message: iconFailure(result), failed: true })
    })
  }
  return <IconChoices icon={ready.icon} root={root} saving={ready.saving} message={ready.message} failed={ready.failed} onChoose={onChoose} />
}

/** Nobody but a catalog moderator sees the block: the categories are shared by every family. */
export default function CategoryIconPicker({ categoryId, root }: { categoryId: number; root: boolean }) {
  return canModerate(useSession()) ? <Picker key={categoryId} categoryId={categoryId} root={root} /> : null
}
