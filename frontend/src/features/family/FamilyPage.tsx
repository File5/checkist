import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  addMember, createFamily, createInvite, getFamily, joinFamily, leaveFamily, removeMember, renameFamily, revokeInvite, transferHead,
} from '../../api/family'
import type { Family, FamilyMember } from '../../api/family'
import type { LocalApiResult } from '../../api/types'
import Sheet from '../../components/Sheet'
import { loadSession } from '../../session'
import { familyFailure, familyTexts, inviteUrl, memberLine } from './family-state'
import type { FamilyAction } from './family-state'
import '../auth/Auth.css'

/** Something shown once: a new password or an invite address. */
export type FamilySecret = { kind: 'password'; username: string; value: string } | { kind: 'invite'; value: string }
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
}

function Secret({ secret, onCopy }: { secret: FamilySecret; onCopy: (value: string) => void }) {
  return <div className="ck-auth-panel" role="status" data-family-secret={secret.kind}>
    <p>{secret.kind === 'password' ? `Пароль для ${secret.username}:` : 'Ссылка-приглашение:'}</p>
    <p className="ck-auth-username"><code>{secret.value}</code></p>
    <p className="ck-auth-rules">{secret.kind === 'password' ? familyTexts.passwordOnce : familyTexts.inviteOnce}</p>
    <div className="ck-auth-actions"><button type="button" className="ck-auth-secondary" onClick={() => onCopy(secret.value)}>Скопировать</button></div>
  </div>
}

function NameForm({ id, label, initial, submitLabel, busy, onSubmit }: {
  id: string; label: string; initial: string; submitLabel: string; busy: boolean; onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && name.trim()) onSubmit(name.trim()) }
  return <form className="ck-auth-panel" onSubmit={submit} noValidate>
    <div className="ck-auth-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} />
    </div>
    <div className="ck-auth-actions"><button type="submit" aria-disabled={busy || undefined}>{submitLabel}</button></div>
  </form>
}

function AddMemberForm({ busy, onAdd }: { busy: boolean; onAdd: FamilyViewProps['onAdd'] }) {
  const [values, setValues] = useState({ username: '', first_name: '', password: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && values.username.trim()) onAdd({ ...values, username: values.username.trim() })
  }
  const field = (name: keyof typeof values, label: string, type = 'text', autoComplete = 'off') => <div className="ck-auth-field">
    <label htmlFor={`family-${name}`}>{label}</label>
    <input id={`family-${name}`} type={type} autoComplete={autoComplete} value={values[name]} maxLength={150}
      onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
  </div>
  return <form className="ck-auth-panel" onSubmit={submit} noValidate aria-labelledby="family-add-heading" data-family-add>
    <h2 id="family-add-heading">Добавить человека</h2>
    <p className="ck-auth-rules">Новая учётная запись сразу в вашей семье. Пароль можно не вводить — он будет создан.</p>
    {field('username', 'Логин')}
    {field('first_name', 'Имя для показа')}
    {field('password', 'Пароль (необязательно)', 'text', 'new-password')}
    <div className="ck-auth-actions"><button type="submit" aria-disabled={busy || undefined}>Создать учётную запись</button></div>
  </form>
}

export function FamilyView({ family, busy, message, secret, onCreate, onRename, onAdd, onInvite, onRevoke, onAsk, onCopy }: FamilyViewProps) {
  const household = family.household
  const status = message && <p className="ck-auth-rules" role="status" data-family-message>{message}</p>
  if (!household) {
    return <div className="ck-auth" data-family="none">
      <section className="ck-auth-panel"><p>{familyTexts.noFamily}</p></section>
      <NameForm id="family-create-name" label="Название семьи" initial="" submitLabel="Создать семью" busy={busy} onSubmit={onCreate} />
      {status}
    </div>
  }
  const head = family.is_head
  return <div className="ck-auth" data-family={head ? 'head' : 'member'}>
    {status}
    {secret && <Secret secret={secret} onCopy={onCopy} />}
    <section className="ck-auth-panel" aria-labelledby="family-members-heading">
      <h2 id="family-members-heading">{household.name}</h2>
      <ul className="ck-auth-rules" data-family-members>
        {household.members.map((member) => <li key={member.username}>
          <span>{memberLine(member)}</span>
          {head && !member.is_me && <span className="ck-auth-actions">
            <button type="button" className="ck-auth-secondary" onClick={() => onAsk({ kind: 'head', member })}>Сделать главным</button>
            <button type="button" className="ck-auth-secondary" onClick={() => onAsk({ kind: 'remove', member })}>Убрать из семьи</button>
          </span>}
        </li>)}
      </ul>
      {!head && <div className="ck-auth-actions">
        <button type="button" className="ck-auth-secondary" data-family-leave onClick={() => onAsk({ kind: 'leave' })}>Выйти из семьи</button>
      </div>}
    </section>
    {head && <>
      <AddMemberForm busy={busy} onAdd={onAdd} />
      <section className="ck-auth-panel" aria-labelledby="family-invite-heading" data-family-invites>
        <h2 id="family-invite-heading">Приглашение</h2>
        <p className="ck-auth-rules">Для человека, у которого уже есть учётная запись. {familyTexts.inviteOnce}</p>
        {family.invites.length > 0 && <ul className="ck-auth-rules">{family.invites.map((invite) => <li key={invite.id}>
          Действует до <time dateTime={invite.expires_at}>{new Date(invite.expires_at).toLocaleDateString('ru-RU')}</time>{' '}
          <button type="button" className="ck-auth-secondary" onClick={() => onRevoke(invite.id)}>Отозвать</button>
        </li>)}</ul>}
        <div className="ck-auth-actions"><button type="button" aria-disabled={busy || undefined} onClick={busy ? undefined : onInvite}>Создать приглашение</button></div>
      </section>
      <NameForm key={household.name} id="family-rename" label="Название семьи" initial={household.name} submitLabel="Переименовать" busy={busy} onSubmit={onRename} />
    </>}
  </div>
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
      onAsk={setConfirm}
      onCopy={(value) => { void navigator.clipboard?.writeText(value).then(() => setMessage('Скопировано.'), () => setMessage('Скопируйте вручную.')) }} />
    <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title={asked?.title ?? ''} id="family-confirm">
      <p>{asked?.text}</p>
      <div className="ck-auth-actions">
        <button type="button" data-family-confirm onClick={answer}>{asked?.action}</button>
        <button type="button" className="ck-auth-secondary" onClick={() => setConfirm(null)}>Отмена</button>
      </div>
    </Sheet>
  </>
}
