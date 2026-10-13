import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isFamily } from '../../api/family'
import type { Family, FamilyAi } from '../../api/family'
import { readError } from '../../api/http'
import type { AuthFailure } from '../../api/session'
import type { LocalApiFailure } from '../../api/types'
import { aiRefusalText, aiResetText, aiTexts } from '../../lib/ai'
import { NBSP } from '../../lib/text'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { requestFailureMessage } from '../expense/parse-text'
import { errorText } from '../recognition/labels'
import { aiUsageText, checkNewFamily, familyFailure, familyTexts, newFamilyRefusal, newFamilyTexts } from './family-state'
import { FamilyView } from './FamilyPage'
import type { FamilyViewProps } from './FamilyPage'
import { NewFamilyView } from './NewFamilyPage'
import type { NewFamilyViewProps } from './NewFamilyPage'

const noop = () => {}
const members: NonNullable<Family['household']>['members'] = [
  { username: 'demo-head', display_name: 'Андрей', role: 'head', is_me: true },
  { username: 'demo-kid', display_name: 'Лиза', role: 'member', is_me: false },
]
const ai: FamilyAi = { enabled: true, daily_limit: 50, used_today: 12, resets_at: '2026-10-14T00:00:00Z' }
const family = (extra: Partial<Family> = {}): Family => ({ household: { id: 1, name: 'Демо-семья', members }, is_head: true, invites: [], ai, ...extra })
const view = (value: Family, extra: Partial<FamilyViewProps> = {}) => renderToStaticMarkup(<FamilyView family={value} busy={false} message={null} secret={null}
  onCreate={noop} onRename={noop} onAdd={noop} onInvite={noop} onRevoke={noop} onAsk={noop} onCopy={noop} {...extra} />)
const failure = (reason: LocalApiFailure['reason'], extra: Partial<LocalApiFailure> = {}): LocalApiFailure => ({ kind: 'error', reason, ...extra })

describe('ИИ of the family', () => {
  it('gives the head a switch with the note and the requests of today', () => {
    const html = view(family())
    expect(html).toContain('data-family-ai="on"')
    expect(html).toMatch(/<button type="button" role="switch" class="family-switch" aria-checked="true" aria-labelledby="family-ai-heading"/)
    expect(html).toContain('Распознавание и подсказки ИИ')
    expect(html).toContain(familyTexts.aiNote)
    expect(html).toContain(`Сегодня использовано 12${NBSP}из${NBSP}50`)
    expect(html).toContain('style="width:24%"')
    expect(view(family({ ai: { ...ai, enabled: false } }))).toMatch(/role="switch" class="family-switch" aria-checked="false"/)
  })

  it('shows a member the state in words, without the switch', () => {
    const html = view(family({ is_head: false, ai: { ...ai, enabled: false } }))
    expect(html).toContain('data-family-ai="off"')
    expect(html).not.toContain('role="switch"')
    expect(html).toContain('<span class="family-ai-state">Выключено</span>')
    expect(html).toContain(familyTexts.aiHeadOnly)
  })

  it('has no panel without a family or from an older server', () => {
    expect(view({ household: null, is_head: true, invites: [], ai: null })).not.toContain('data-family-ai')
    expect(view(family({ ai: undefined }))).not.toContain('data-family-ai')
  })

  it('says the two refusals in place, with the time the quota starts again', () => {
    const now = new Date(2026, 9, 13, 20, 0)
    expect(aiRefusalText(failure('ai_disabled'))).toBe('ИИ выключен в вашей семье — включить может главный.')
    const tomorrow = new Date(2026, 9, 14, 5, 0).toISOString()
    expect(aiRefusalText(failure('ai_quota', { resetsAt: tomorrow }), now)).toBe(`${aiTexts.quota} Снова можно завтра в${NBSP}05:00.`)
    expect(aiRefusalText(failure('ai_quota'), now)).toBe(aiTexts.quota)
    expect(aiResetText(new Date(2026, 9, 13, 23, 30).toISOString(), now)).toBe(`Снова можно сегодня в${NBSP}23:30.`)
    expect(aiResetText(new Date(2026, 9, 16, 5, 0).toISOString(), now)).toBe(`Снова можно 16${NBSP}октября в${NBSP}05:00.`)
    expect(aiResetText('not a date', now)).toBe('')
    expect(aiRefusalText(failure('parse_limit'))).toBeUndefined()
    // The same words on «Трата словами» and on the photo upload.
    expect(requestFailureMessage(failure('ai_disabled'))).toBe(aiTexts.disabled)
    expect(requestFailureMessage(failure('ai_quota'))).toBe(aiTexts.quota)
    expect(errorText(failure('ai_disabled'), true)).toBe(aiTexts.disabled)
    expect(errorText(failure('ai_quota'))).toBe(aiTexts.quota)
  })

  it('reads the refusals from the wire', () => {
    const body = (code: string, extra = {}) => ({ error: { code, message: 'x' }, ...extra })
    expect(readError(403, body('ai_disabled'), true)).toEqual({ kind: 'error', reason: 'ai_disabled', status: 403 })
    expect(readError(429, body('ai_quota', { resets_at: '2026-10-14T00:00:00Z' }), true))
      .toEqual({ kind: 'error', reason: 'ai_quota', status: 429, resetsAt: '2026-10-14T00:00:00Z' })
    expect(readError(429, body('ai_quota', { resets_at: 'soon' }), true)).toEqual({ kind: 'error', reason: 'ai_quota', status: 429 })
    expect(readError(429, body('ai_disabled'), true).reason).toBe('invalid_response')
  })

  it('reads the family answer of an older and of this server', () => {
    expect(isFamily({ household: null, is_head: true, invites: [] })).toBe(true)
    expect(isFamily({ ...family(), can_invite_families: true, family_invites: [] })).toBe(true)
    expect(isFamily({ ...family(), ai: { ...ai, used_today: -1 } })).toBe(false)
    expect(isFamily({ ...family(), can_invite_families: 'yes' })).toBe(false)
    expect(aiUsageText(ai)).toBe(`Сегодня использовано 12${NBSP}из${NBSP}50`)
  })
})

describe('invites of new families', () => {
  const invite = { id: 7, created_at: '2026-10-13T10:00:00Z', expires_at: '2026-10-20T10:00:00Z' }

  it('are offered to the server owner only, with or without a family', () => {
    const html = view(family({ can_invite_families: true, family_invites: [invite] }))
    expect(html).toContain('data-family-new-invites')
    expect(html).toContain('Пригласить новую семью')
    expect(html).toContain('Новая семья')
    expect(view({ household: null, is_head: true, invites: [], can_invite_families: true, family_invites: [] })).toContain('Пригласить новую семью')
    expect(view(family({ can_invite_families: false }))).not.toContain('data-family-new-invites')
    expect(view(family())).not.toContain('data-family-new-invites')
  })

  it('shows the one-time link inside its own card', () => {
    const html = view(family({ can_invite_families: true, family_invites: [] }),
      { secret: { kind: 'family-invite', value: 'https://example.test/family/new?token=Synthetic_Token' } })
    const card = html.slice(html.indexOf('data-family-new-invites'))
    expect(card).toContain('data-family-secret="family-invite"')
    expect(card).toContain('Ссылка на новую семью')
    expect(card).toContain(familyTexts.familyInviteOnce)
    expect(html.match(/data-family-secret=/g)).toHaveLength(1)
  })

  it('names a refusal of a person who is not the server owner', () => {
    const refused = { kind: 'error' as const, reason: 'invalid_response' as const, status: 403 }
    expect(familyFailure('family-invite', refused)).toBe(familyTexts.staffOnly)
    expect(familyFailure('family-revoke', refused)).toBe(familyTexts.staffOnly)
    expect(familyFailure('ai', refused)).toBe(familyTexts.headOnly)
  })

  it('has its own address with a token', () => {
    expect(parseRoute('http://x/family/new?token=Abc_123-xyz')).toEqual({ kind: 'family-new', token: 'Abc_123-xyz' })
    expect(parseRoute('http://x/family/new?token=<bad>')).toEqual({ kind: 'family-new' })
    expect(parseRoute('http://x/family/new')).toEqual({ kind: 'family-new' })
    expect(buildRoute({ kind: 'family-new', token: 'Abc_123-xyz' })).toBe('/family/new?token=Abc_123-xyz')
  })
})

describe('the screen of a new family', () => {
  const values = { name: '', first_name: '', username: '', password: '' }
  const screen = (extra: Partial<NewFamilyViewProps>) => renderToStaticMarkup(<NewFamilyView check={{ kind: 'checking' }} state={{ kind: 'idle' }}
    values={values} onChange={noop} onSubmit={noop} onRetry={noop} heading={<h1 id="page-heading">Новая семья</h1>} {...extra} />)

  it('checks the link first and shows the form only for a valid one', () => {
    expect(screen({})).toContain('Проверяем приглашение…')
    expect(screen({})).not.toContain('<form')
    const invalid = screen({ check: { kind: 'invalid', message: newFamilyTexts.invalid } })
    expect(invalid).toContain(newFamilyTexts.invalid)
    expect(invalid).not.toContain('<form')
    expect(screen({ check: { kind: 'failed' } })).toContain('Повторить')
    const html = screen({ check: { kind: 'valid', expiresAt: '2026-10-20T10:00:00Z' } })
    expect(html).toContain('<main id="main" class="ck-login">')
    for (const [name, label] of [['name', 'Название семьи'], ['first_name', 'Как вас зовут'], ['username', 'Логин для входа'], ['password', 'Пароль']]) {
      expect(html).toContain(`<label for="new-family-${name}">${label}</label>`)
    }
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('Создать семью')
    expect(html).toContain('<time dateTime="2026-10-20T10:00:00Z"')
    expect(html).toContain('href="/login"')
  })

  it('marks the refused fields and lists the password rules', () => {
    const html = screen({ check: { kind: 'valid', expiresAt: '2026-10-20T10:00:00Z' },
      state: { kind: 'failed', message: 'Проверьте: логин.', fields: ['username'], details: [] } })
    expect(html).toMatch(/id="new-family-username"[^>]*aria-invalid="true"/)
    expect(html).not.toMatch(/id="new-family-name"[^>]*aria-invalid="true"/)
    expect(html).toContain('не короче 8 символов')
  })

  it('refuses empty fields before any request and names the server refusals', () => {
    expect(checkNewFamily(values)).toEqual({ message: newFamilyTexts.required, fields: ['name', 'username', 'password'] })
    expect(checkNewFamily({ name: 'Семья', first_name: '', username: 'demo', password: 'x' })).toBeUndefined()
    const auth = (reason: AuthFailure['reason'], extra: Partial<AuthFailure> = {}): AuthFailure => ({ kind: 'error', reason, ...extra })
    expect(newFamilyRefusal(auth('invite_invalid')).message).toBe(newFamilyTexts.invalid)
    expect(newFamilyRefusal(auth('already_signed_in')).message).toBe(newFamilyTexts.signedIn)
    const weak = newFamilyRefusal(auth('invalid_parameter', { fields: ['password'], passwordIssues: ['entirely_numeric'] }))
    expect(weak).toEqual({ message: 'Проверьте: пароль.', fields: ['password'], details: ['Пароль: не должен состоять только из цифр.'] })
    const both = newFamilyRefusal(auth('invalid_parameter', { fields: ['username', 'name'] }))
    expect(both.message).toBe('Проверьте: логин, название семьи.')
    expect(both.details?.[0]).toContain('Логин:')
    expect(newFamilyRefusal(auth('login_throttled', { retryAfter: 600 })).message).toBe('Слишком много попыток. Повторите через 10 минут.')
  })
})
