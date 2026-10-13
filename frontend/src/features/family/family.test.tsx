import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isFamily } from '../../api/family'
import type { Family } from '../../api/family'
import { parseRoute, buildRoute } from '../../navigation/routes'
import { familyFailure, familyTexts, inviteUrl, memberLine, memberMeta, visibleFromMonths, visibleFromText } from './family-state'
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
    // Actions on another member only, never on oneself: that member's row opens the sheet of «Сделать главным» and
    // «Убрать из семьи»; the head's own row is plain and carries the mark of the head.
    expect(html.match(/data-family-manage="true"/g)).toHaveLength(1)
    expect(html).toMatch(/<button type="button" class="family-member family-member-button"[^>]*>.*demo-kid.*<\/button>/)
    expect(html).toContain('<span class="family-role">')
    expect(html).not.toContain('Выйти из семьи')
    // Initials in a circle, the login and the role under the name.
    expect(html).toContain('<span class="family-avatar family-tone-1" aria-hidden="true">А</span>')
    expect(html).toContain('<span class="family-member-meta">demo-head · это вы</span>')
  })

  it('gives a member only the family and leaving', () => {
    const html = view({ household: { id: 1, name: 'Демо-семья', members: members.map((m) => ({ ...m, is_me: !m.is_me })) }, is_head: false, invites: [] })
    expect(html).toContain('data-family="member"')
    expect(html).toContain('Выйти из семьи')
    expect(html).toContain('<button type="button" class="ck-auth-danger" data-family-leave="true">Выйти из семьи</button>')
    expect(html).not.toContain('Добавить человека')
    expect(html).not.toContain('data-family-manage')
    expect(html).not.toContain('Переименовать')
  })

  it('asks for the fields of a new person as rows with their words on the left', () => {
    const html = view({ household: { id: 1, name: 'Демо', members }, is_head: true, invites: [] })
    for (const [id, label] of [['family-username', 'Логин'], ['family-first_name', 'Имя для показа'], ['family-password', 'Пароль']]) {
      expect(html).toMatch(new RegExp(`<label class="family-field" for="${id}"><span>${label}</span><input id="${id}"`))
    }
    expect(html).toContain('<button type="submit" class="ck-auth-primary">Создать учётную запись</button>')
    expect(html).toContain('<button type="button" class="ck-auth-secondary">Создать приглашение</button>')
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
    expect(memberMeta(members[0])).toBe('demo-head · это вы')
    expect(memberMeta(members[1])).toBe('член семьи')
    expect(memberMeta({ ...members[1], display_name: 'Катя', role: 'head' })).toBe('demo-kid')
    const refused = (status: number, fields?: string[]) => ({ kind: 'error' as const, reason: 'server' as const, status, ...(fields && { fields }) })
    expect(familyFailure('add', refused(403))).toBe(familyTexts.headOnly)
    expect(familyFailure('leave', refused(409))).toBe(familyTexts.headMustTransfer)
    expect(familyFailure('join', refused(409))).toBe(familyTexts.alreadyInFamily)
    expect(familyFailure('join', refused(400))).toBe(familyTexts.inviteInvalid)
    expect(familyFailure('join', refused(429))).toBe(familyTexts.throttled)
    expect(familyFailure('add', refused(400, ['username', 'password']))).toBe('Проверьте: логин, пароль.')
    expect(inviteUrl('/family/join?token=abc', 'https://example.test')).toBe('https://example.test/family/join?token=abc')
  })

  it('shows the head since when each member sees the spends of the family, never a member', () => {
    const limited = [members[0], { ...members[1], visible_from: '2026-09' }, { username: 'demo-two', display_name: 'Катя', role: 'member' as const, is_me: false, visible_from: null }]
    const html = view({ household: { id: 1, name: 'Демо', members: limited }, is_head: true, invites: [] })
    expect(html).toContain('<span class="family-member-since" data-family-visible-from="true">Видит траты семьи: с сентября 2026</span>')
    expect(html).toContain('Видит траты семьи: с начала')
    expect(html.match(/data-family-visible-from/g)).toHaveLength(2)
    // A member gets no `visible_from` from the server: no line about it at all.
    const asMember = view({ household: { id: 1, name: 'Демо', members: members.map((m) => ({ ...m, is_me: !m.is_me })) }, is_head: false, invites: [] })
    expect(asMember).not.toContain('Видит траты')
    expect(visibleFromText(null)).toBe('с начала')
    expect(visibleFromText('2026-01')).toBe('с января 2026')
    const months = visibleFromMonths(null, '2026-10')
    expect([months.length, months[0], months[1], months[23]]).toEqual([24, '2026-10', '2026-09', '2024-11'])
    expect(visibleFromMonths('2020-03', '2026-10').at(-1)).toBe('2020-03')
    expect(familyFailure('visible', { kind: 'error', reason: 'server', status: 400, fields: ['visible_from'] })).toBe('Проверьте: месяц.')
  })

  it('reads the family answer and the routes', () => {
    const withMonth = (visible_from: unknown) => ({ household: { id: 1, name: 'x', members: [{ ...members[1], visible_from }] }, is_head: true, invites: [] })
    expect([isFamily(withMonth('2026-09')), isFamily(withMonth(null)), isFamily(withMonth('2026-13')), isFamily(withMonth(202609))])
      .toEqual([true, true, false, false])
    expect(isFamily({ household: null, is_head: true, invites: [] })).toBe(true)
    expect(isFamily({ household: { id: 1, name: 'x', members: [{ username: 'a', display_name: 'a', role: 'boss', is_me: true }] }, is_head: true, invites: [] })).toBe(false)
    expect(parseRoute('http://x/family')).toEqual({ kind: 'family' })
    expect(parseRoute('http://x/family/join?token=Abc_123-xyz')).toEqual({ kind: 'family', token: 'Abc_123-xyz' })
    expect(parseRoute('http://x/family/join?token=<bad>')).toEqual({ kind: 'family' })
    expect(buildRoute({ kind: 'family', token: 'Abc_123-xyz' })).toBe('/family/join?token=Abc_123-xyz')
  })
})
