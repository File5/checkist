import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  addMember, createFamily, createFamilyInvite, createInvite, getFamily, joinFamily, leaveFamily, removeMember, renameFamily,
  revokeFamilyInvite, revokeInvite, setFamilyAi, transferHead,
} from '../../api/family'
import type { Family, FamilyAi, FamilyInvite, FamilyMember } from '../../api/family'
import type { LocalApiResult } from '../../api/types'
import Sheet from '../../components/Sheet'
import { loadSession } from '../../session'
import { initials } from '../../lib/people'
import { aiUsageText, familyFailure, familyTexts, inviteUrl, memberMeta } from './family-state'
import type { FamilyAction } from './family-state'
import '../auth/Auth.css'
import './Family.css'

/** Something shown once: a new password, an invite address, the address of a new family (for the server owner). */
export type FamilySecret = { kind: 'password'; username: string; value: string } | { kind: 'invite' | 'family-invite'; value: string }
/** A question in the sheet before an action that changes the family for another person. */
export type FamilyConfirm = { kind: 'remove' | 'head'; member: FamilyMember } | { kind: 'leave' }

export type FamilyViewProps = {
  family: Family
  busy: boolean
  message: string | null
  secret: FamilySecret | null
  onCreate: (name: string) => void
  onRename: (name: string) => void
  onAdd: (input: { username: string; first_name: string; password: string }) => void
  onInvite: () => void
  onRevoke: (id: number) => void
  onAsk: (confirm: FamilyConfirm) => void
  onCopy: (value: string) => void
  /** The head switches ИИ of the family. */
  onAi?: (enabled: boolean) => void
  /** The server owner invites a new family and revokes such an invite. */
  onFamilyInvite?: () => void
  onRevokeFamily?: (id: number) => void
}

const star = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 2.5 2.8 6.1 6.7.7-5 4.5 1.4 6.6L12 17l-5.9 3.4 1.4-6.6-5-4.5 6.7-.7L12 2.5Z" /></svg>
const chevron = <svg className="family-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
const linkIcon = <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>

const secretTexts = (secret: FamilySecret) => {
  switch (secret.kind) {
    case 'password': return { label: `Пароль для ${secret.username}`, note: familyTexts.passwordOnce }
    case 'invite': return { label: 'Ссылка-приглашение', note: familyTexts.inviteOnce }
    case 'family-invite': return { label: 'Ссылка на новую семью', note: familyTexts.familyInviteOnce }
  }
}

function Secret({ secret, onCopy }: { secret: FamilySecret; onCopy: (value: string) => void }) {
  const { label, note } = secretTexts(secret)
  return <section className="ck-auth-panel family-secret" role="status" data-family-secret={secret.kind}>
    <p className="family-secret-label">{label}</p>
    <p className="family-secret-value"><code>{secret.value}</code></p>
    <p className="family-note">{note}</p>
    <button type="button" className="ck-auth-primary" onClick={() => onCopy(secret.value)}>Скопировать</button>
  </section>
}

/** One active invite: the icon, until when, «Отозвать». */
function InviteRow({ invite, label, onRevoke }: { invite: FamilyInvite; label: string; onRevoke: (id: number) => void }) {
  return <li className="family-invite">
    <span className="family-invite-icon">{linkIcon}</span>
    <span className="family-member-text">
      <span>{label}</span>
      <span className="family-member-meta">до <time dateTime={invite.expires_at}>{new Date(invite.expires_at).toLocaleDateString('ru-RU')}</time></span>
    </span>
    <button type="button" className="ck-auth-danger" onClick={() => onRevoke(invite.id)}>Отозвать</button>
  </li>
}

/** ИИ of the family: the switch of the head (a member sees the state), what it means, the requests of today. */
function AiPanel({ ai, head, busy, onAi }: { ai: FamilyAi; head: boolean; busy: boolean; onAi?: (enabled: boolean) => void }) {
  // Without a limit there is nothing to fill: the count of today only, no bar.
  const limit = ai.daily_limit
  const share = limit === null ? null : limit > 0 ? Math.min(100, Math.round((ai.used_today / limit) * 100)) : 100
  return <section className="ck-auth-panel family-ai" aria-labelledby="family-ai-heading" data-family-ai={ai.enabled ? 'on' : 'off'}>
    <div className="family-ai-head">
      <h2 id="family-ai-heading">Распознавание и подсказки ИИ</h2>
      {head
        ? <button type="button" role="switch" className="family-switch" aria-checked={ai.enabled} aria-labelledby="family-ai-heading"
          aria-describedby="family-ai-note" aria-disabled={busy || undefined} data-family-ai-switch
          onClick={busy ? undefined : () => onAi?.(!ai.enabled)}><span className="family-switch-thumb" /></button>
        : <span className={`family-ai-state${ai.enabled ? ' family-ai-on' : ''}`}>{ai.enabled ? 'Включено' : 'Выключено'}</span>}
    </div>
    <p id="family-ai-note" className="family-note family-sub">{familyTexts.aiNote}{head ? '' : ` ${familyTexts.aiHeadOnly}`}</p>
    <div className="family-ai-usage">
      <p data-family-ai-usage>{aiUsageText(ai)}</p>
      {share !== null && <div className="ck-bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></div>}
    </div>
  </section>
}

/** The server owner: invites of new families — a link for a person without an account, who creates it and a family. */
function NewFamiliesPanel({ family, secret, busy, onFamilyInvite, onRevokeFamily, onCopy }: Pick<FamilyViewProps,
  'family' | 'secret' | 'busy' | 'onFamilyInvite' | 'onRevokeFamily' | 'onCopy'>) {
  const invites = family.family_invites ?? []
  return <section className="ck-auth-panel" aria-labelledby="family-new-heading" data-family-new-invites>
    <h2 id="family-new-heading">Новые семьи</h2>
    <p className="family-note family-sub">{familyTexts.familyInvites}</p>
    {secret?.kind === 'family-invite' && <Secret secret={secret} onCopy={onCopy} />}
    {invites.length > 0 && <ul className="family-invites" aria-label="Действующие приглашения новых семей">
      {invites.map((invite) => <InviteRow key={invite.id} invite={invite} label="Новая семья" onRevoke={(id) => onRevokeFamily?.(id)} />)}
    </ul>}
    <button type="button" className="ck-auth-secondary" aria-disabled={busy || undefined} data-family-new-invite
      onClick={busy ? undefined : onFamilyInvite}>Пригласить новую семью</button>
  </section>
}

/** A field as a row of the card: the words on the left, the field on the right; the whole row is its label. */
function RowField({ id, label, value, placeholder, type = 'text', autoComplete = 'off', maxLength = 150, onChange }: {
  id: string; label: string; value: string; placeholder?: string; type?: string; autoComplete?: string; maxLength?: number; onChange: (value: string) => void
}) {
  return <label className="family-field" htmlFor={id}>
    <span>{label}</span>
    <input id={id} type={type} autoComplete={autoComplete} value={value} maxLength={maxLength} placeholder={placeholder}
      autoCapitalize="none" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
  </label>
}

function CreateForm({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && name.trim()) onCreate(name.trim()) }
  return <form className="ck-auth-panel" onSubmit={submit} noValidate aria-labelledby="family-create-heading">
    <h2 id="family-create-heading">Семьи пока нет</h2>
    <p className="family-note">{familyTexts.noFamily}</p>
    <div className="family-fields">
      <RowField id="family-create-name" label="Название" value={name} placeholder="Семья Ивановых" maxLength={100} onChange={setName} />
    </div>
    <button type="submit" className="ck-auth-primary" aria-disabled={busy || undefined}>Создать семью</button>
  </form>
}

function RenameForm({ initial, busy, onSubmit }: { initial: string; busy: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(initial)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && name.trim()) onSubmit(name.trim()) }
  return <form className="ck-auth family-confirm" onSubmit={submit} noValidate>
    <div className="ck-auth-field">
      <label htmlFor="family-rename">Название семьи</label>
      <input id="family-rename" value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
    </div>
    <div className="ck-auth-actions"><button type="submit" className="ck-auth-primary" aria-disabled={busy || undefined}>Сохранить</button></div>
  </form>
}

function AddMemberForm({ busy, onAdd }: { busy: boolean; onAdd: FamilyViewProps['onAdd'] }) {
  const [values, setValues] = useState({ username: '', first_name: '', password: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && values.username.trim()) onAdd({ ...values, username: values.username.trim() })
  }
  const set = (name: keyof typeof values) => (value: string) => setValues({ ...values, [name]: value })
  return <form className="ck-auth-panel" onSubmit={submit} noValidate aria-labelledby="family-add-heading" data-family-add>
    <h2 id="family-add-heading">Добавить человека</h2>
    <p className="family-note family-sub">Новая учётная запись сразу в вашей семье.</p>
    <div className="family-fields">
      <RowField id="family-username" label="Логин" value={values.username} placeholder="латиницей" onChange={set('username')} />
      <RowField id="family-first_name" label="Имя для показа" value={values.first_name} placeholder="например, Катя" onChange={set('first_name')} />
      <RowField id="family-password" label="Пароль" value={values.password} placeholder="создадим сами" autoComplete="new-password" onChange={set('password')} />
    </div>
    <button type="submit" className="ck-auth-primary" aria-disabled={busy || undefined}>Создать учётную запись</button>
  </form>
}

export function FamilyView(props: FamilyViewProps) {
  const { family, busy, message, secret, onCreate, onRename, onAdd, onInvite, onRevoke, onAsk, onCopy, onAi } = props
  const [renaming, setRenaming] = useState(false)
  const [managing, setManaging] = useState<FamilyMember | null>(null)
  const household = family.household
  const status = message && <p className="family-notice" role="status" data-family-message>{message}</p>
  const newFamilies = family.can_invite_families ? <NewFamiliesPanel {...props} /> : null
  if (!household) {
    return <div className="ck-auth" data-family="none">
      {status}
      <CreateForm busy={busy} onCreate={onCreate} />
      {newFamilies}
    </div>
  }
  const head = family.is_head
  const count = household.members.length
  return <div className="ck-auth" data-family={head ? 'head' : 'member'}>
    {status}
    {secret && secret.kind !== 'family-invite' && <Secret secret={secret} onCopy={onCopy} />}
    <section className="ck-auth-panel" aria-labelledby="family-members-heading">
      <div className="ck-auth-head">
        <h2 id="family-members-heading">{household.name}</h2>
        {head && <button type="button" className="ck-auth-link" aria-haspopup="dialog" aria-expanded={renaming} aria-controls="family-rename-sheet"
          onClick={() => setRenaming(true)}>Переименовать</button>}
      </div>
      <p className="family-sub">{peopleCount(count)}</p>
      <ul className="family-members" data-family-members>
        {household.members.map((member, index) => {
          const face = <>
            <span className={`family-avatar family-tone-${(index % 6) + 1}`} aria-hidden="true">{initials(member.display_name)}</span>
            <span className="family-member-text">
              <span className="family-member-name">{member.display_name}</span>
              {memberMeta(member) && <span className="family-member-meta">{memberMeta(member)}</span>}
            </span>
          </>
          return <li key={member.username}>
            {head && !member.is_me
              ? <button type="button" className="family-member family-member-button" aria-haspopup="dialog" aria-controls="family-member-sheet"
                aria-expanded={managing?.username === member.username} data-family-manage onClick={() => setManaging(member)}>
                {face}{chevron}
              </button>
              : <div className="family-member">
                {face}
                {member.role === 'head' && <span className="family-role">{star}Главный</span>}
              </div>}
          </li>
        })}
      </ul>
      {!head && <button type="button" className="ck-auth-danger" data-family-leave onClick={() => onAsk({ kind: 'leave' })}>Выйти из семьи</button>}
    </section>
    {family.ai && <AiPanel ai={family.ai} head={head} busy={busy} onAi={onAi} />}
    {head && <>
      <AddMemberForm busy={busy} onAdd={onAdd} />
      <section className="ck-auth-panel" aria-labelledby="family-invite-heading" data-family-invites>
        <h2 id="family-invite-heading">Приглашение</h2>
        <p className="family-note family-sub">Для человека, у которого уже есть учётная запись. {familyTexts.inviteOnce}</p>
        {family.invites.length > 0 && <ul className="family-invites" aria-label="Действующие приглашения">
          {family.invites.map((invite) => <InviteRow key={invite.id} invite={invite} label="Приглашение" onRevoke={onRevoke} />)}
        </ul>}
        <button type="button" className="ck-auth-secondary" aria-disabled={busy || undefined} onClick={busy ? undefined : onInvite}>Создать приглашение</button>
      </section>
      <Sheet open={managing !== null} onClose={() => setManaging(null)} title={managing?.display_name ?? ''} id="family-member-sheet">
        {managing && <div className="ck-auth family-confirm">
          {memberMeta(managing) && <p className="family-note">{memberMeta(managing)}</p>}
          <div className="ck-auth-actions">
            <button type="button" className="ck-auth-secondary" onClick={() => { setManaging(null); onAsk({ kind: 'head', member: managing }) }}>Сделать главным</button>
            <button type="button" className="ck-auth-danger" onClick={() => { setManaging(null); onAsk({ kind: 'remove', member: managing }) }}>Убрать из семьи</button>
          </div>
        </div>}
      </Sheet>
      <Sheet open={renaming} onClose={() => setRenaming(false)} title="Переименовать семью" id="family-rename-sheet">
        <RenameForm key={household.name} initial={household.name} busy={busy} onSubmit={(name) => { setRenaming(false); onRename(name) }} />
      </Sheet>
    </>}
    {newFamilies}
  </div>
}

const peopleCount = (count: number) => {
  const tens = count % 100
  const units = count % 10
  const word = tens >= 11 && tens <= 14 ? 'человек' : units >= 2 && units <= 4 ? 'человека' : 'человек'
  return `${count} ${word} · видят траты друг друга`
}

const confirmTexts = (confirm: FamilyConfirm) => {
  switch (confirm.kind) {
    case 'remove': return { title: 'Убрать из семьи', text: `${confirm.member.display_name} больше не увидит траты семьи. Его чеки останутся за ним.`, action: 'Убрать' }
    case 'head': return { title: 'Передать роль главного', text: `Главным станет ${confirm.member.display_name}; вы останетесь членом семьи и не сможете скрывать платежи.`, action: 'Передать' }
    case 'leave': return { title: 'Выйти из семьи', text: 'Вы перестанете видеть траты семьи; ваши чеки останутся у вас.', action: 'Выйти' }
  }
}

/** `/family`: create a family, its members, invites, the head role and leaving it. `joinToken` — `/family/join?token=…`. */
export default function FamilyPage({ joinToken }: { joinToken?: string }) {
  const [family, setFamily] = useState<Family | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [secret, setSecret] = useState<FamilySecret | null>(null)
  const [confirm, setConfirm] = useState<FamilyConfirm | null>(null)
  const joinTried = useRef(false)
  const reload = useCallback(() => {
    void getFamily().then((result) => {
      if (result.kind === 'ok') setFamily(result.data)
      else if (result.kind === 'error') setLoadFailed(true)
    })
  }, [])
  useEffect(reload, [reload])

  const run = <T,>(action: FamilyAction, request: () => Promise<LocalApiResult<T>>, done: (data: T) => string | null) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    void request().then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        setMessage(done(result.data))
        reload()
        // Roles and the household of «Я» changed: the head role decides who hides payments.
        void loadSession()
      } else setMessage(familyFailure(action, result))
    })
  }
  const asFamily = (data: unknown) => { if (data && typeof data === 'object' && 'is_head' in data) setFamily(data as Family) }

  // The invite is accepted once, after «Семья» showed that the person has no family yet.
  const joinable = joinToken !== undefined && family !== null && family.household === null
  useEffect(() => {
    if (!joinable || joinTried.current) return
    joinTried.current = true
    run('join', () => joinFamily(joinToken), (data) => { asFamily(data); return 'Вы в семье.' })
  })
  if (loadFailed) return <p role="alert">Не удалось загрузить семью. Обновите страницу.</p>
  if (!family) return <p role="status">Загружаем…</p>
  const asked = confirm && confirmTexts(confirm)
  const answer = () => {
    if (!confirm) return
    setConfirm(null)
    if (confirm.kind === 'leave') run('leave', () => leaveFamily(), (data) => { asFamily(data); return 'Вы вышли из семьи.' })
    else if (confirm.kind === 'remove') run('remove', () => removeMember(confirm.member.username), () => 'Человек убран из семьи.')
    else run('head', () => transferHead(confirm.member.username), (data) => { asFamily(data); return `Главный теперь ${confirm.member.display_name}.` })
  }
  return <>
    <FamilyView family={family} busy={busy} message={message} secret={secret}
      onCreate={(name) => run('create', () => createFamily(name), (data) => { asFamily(data); return 'Семья создана: вы её главный.' })}
      onRename={(name) => run('rename', () => renameFamily(name), () => 'Название сохранено.')}
      onAdd={(input) => run('add', () => addMember(input), (data) => {
        setSecret({ kind: 'password', username: data.member.username, value: data.password })
        return `Учётная запись ${data.member.username} создана.`
      })}
      onInvite={() => run('invite', () => createInvite(), (data) => { setSecret({ kind: 'invite', value: inviteUrl(data.path, window.location.origin) }); return 'Приглашение создано.' })}
      onRevoke={(id) => run('revoke', () => revokeInvite(id), () => 'Приглашение отозвано.')}
      // The switch and the link of a new family answer in place: the switch itself, the link inside its card.
      onAi={(enabled) => run('ai', () => setFamilyAi(enabled), (data) => { asFamily(data); return null })}
      onFamilyInvite={() => run('family-invite', () => createFamilyInvite(), (data) => {
        setSecret({ kind: 'family-invite', value: inviteUrl(data.path, window.location.origin) })
        return null
      })}
      onRevokeFamily={(id) => run('family-revoke', () => revokeFamilyInvite(id), () => 'Приглашение новой семьи отозвано.')}
      onAsk={setConfirm}
      onCopy={(value) => { void navigator.clipboard?.writeText(value).then(() => setMessage('Скопировано.'), () => setMessage('Скопируйте вручную.')) }} />
    <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title={asked?.title ?? ''} id="family-confirm">
      <div className="ck-auth family-confirm">
        <p>{asked?.text}</p>
        <div className="ck-auth-actions">
          <button type="button" className={confirm?.kind === 'head' ? 'ck-auth-primary' : 'ck-auth-danger'} data-family-confirm onClick={answer}>{asked?.action}</button>
          <button type="button" className="ck-auth-secondary" onClick={() => setConfirm(null)}>Отмена</button>
        </div>
      </div>
    </Sheet>
  </>
}
