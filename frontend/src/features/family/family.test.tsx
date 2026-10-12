import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isFamily } from '../../api/family'
import type { Family } from '../../api/family'
import { parseRoute, buildRoute } from '../../navigation/routes'
import { familyFailure, familyTexts, inviteUrl, memberLine } from './family-state'
import { FamilyView } from './FamilyPage'
import type { FamilyViewProps } from './FamilyPage'

const noop = () => {}
const members: NonNullable<Family['household']>['members'] = [
  { username: 'demo-head', display_name: 'Андрей', role: 'head', is_me: true },
  { username: 'demo-kid', display_name: 'demo-kid', role: 'member', is_me: false },
]
const view = (family: Family, extra: Partial<FamilyViewProps> = {}) => renderToStaticMarkup(<FamilyView family={family} busy={false} message={null} secret={null}
  onCreate={noop} onRename={noop} onAdd={noop} onInvite={noop} onRevoke={noop} onAsk={noop} onCopy={noop} {...extra} />)

describe('family screen', () => {
  it('offers to create a family when there is none', () => {
    const html = view({ household: null, is_head: true, invites: [] })
    expect(html).toContain('data-family="none"')
    expect(html).toContain('Создать семью')
    expect(html).not.toContain('Добавить человека')
  })

  it('gives the head members, invites and rename', () => {
    const html = view({ household: { id: 1, name: 'Демо-семья', members }, is_head: true,
      invites: [{ id: 3, created_at: '2026-10-12T10:00:00Z', expires_at: '2026-10-19T10:00:00Z' }] })
    expect(html).toContain('data-family="head"')
    expect(html).toContain('Добавить человека')
    expect(html).toContain('Создать приглашение')
    expect(html).toContain('Отозвать')
    expect(html).toContain('Переименовать')
    // Actions on another member only, never on oneself.
    expect(html.split('Убрать из семьи').length - 1).toBe(1)
    expect(html).not.toContain('Выйти из семьи')
  })

  it('gives a member only the family and leaving', () => {
    const html = view({ household: { id: 1, name: 'Демо-семья', members: members.map((m) => ({ ...m, is_me: !m.is_me })) }, is_head: false, invites: [] })
    expect(html).toContain('data-family="member"')
    expect(html).toContain('Выйти из семьи')
    expect(html).not.toContain('Добавить человека')
    expect(html).not.toContain('Убрать из семьи')
  })

  it('shows the one-time password with a copy button', () => {
    const html = view({ household: { id: 1, name: 'Демо', members }, is_head: true, invites: [] },
      { secret: { kind: 'password', username: 'demo-kid', value: 'Synthetic-One-Time' } })
    expect(html).toContain('Synthetic-One-Time')
    expect(html).toContain('Скопировать')
    expect(html).toContain(familyTexts.passwordOnce)
  })

  it('names members and refusals', () => {
    expect(memberLine(members[0])).toBe('Андрей (demo-head) · главный · это вы')
    expect(memberLine(members[1])).toBe('demo-kid · член семьи')
    const refused = (status: number, fields?: string[]) => ({ kind: 'error' as const, reason: 'server' as const, status, ...(fields && { fields }) })
    expect(familyFailure('add', refused(403))).toBe(familyTexts.headOnly)
    expect(familyFailure('leave', refused(409))).toBe(familyTexts.headMustTransfer)
    expect(familyFailure('join', refused(409))).toBe(familyTexts.alreadyInFamily)
    expect(familyFailure('join', refused(400))).toBe(familyTexts.inviteInvalid)
    expect(familyFailure('join', refused(429))).toBe(familyTexts.throttled)
    expect(familyFailure('add', refused(400, ['username', 'password']))).toBe('Проверьте: логин, пароль.')
    expect(inviteUrl('/family/join?token=abc', 'https://example.test')).toBe('https://example.test/family/join?token=abc')
  })

  it('reads the family answer and the routes', () => {
    expect(isFamily({ household: null, is_head: true, invites: [] })).toBe(true)
    expect(isFamily({ household: { id: 1, name: 'x', members: [{ username: 'a', display_name: 'a', role: 'boss', is_me: true }] }, is_head: true, invites: [] })).toBe(false)
    expect(parseRoute('http://x/family')).toEqual({ kind: 'family' })
    expect(parseRoute('http://x/family/join?token=Abc_123-xyz')).toEqual({ kind: 'family', token: 'Abc_123-xyz' })
    expect(parseRoute('http://x/family/join?token=<bad>')).toEqual({ kind: 'family' })
    expect(buildRoute({ kind: 'family', token: 'Abc_123-xyz' })).toBe('/family/join?token=Abc_123-xyz')
  })
})
