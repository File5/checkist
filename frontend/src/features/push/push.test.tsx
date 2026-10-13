import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isPushState } from '../../api/push'
import type { PushState } from '../../api/push'
import { PushView } from './PushSection'
import { pushTexts } from './push-texts'
import type { PushSectionState } from './PushSection'
import { pushSupport, serverKey } from './push-device'
import type { DeviceInfo } from './push-device'

const push = (extra: Partial<PushState> = {}): PushState => ({
  configured: true, public_key: 'BPublicKey', devices: 0, base_currency: 'KZT',
  settings: { recurring: true, limits: true, weekly: true, monthly: true, large: false, large_threshold: '100000.00' },
  ...extra,
})
const ready = (extra: Partial<Extract<PushSectionState, { kind: 'ready' }>> = {}): PushSectionState => ({
  kind: 'ready', push: push(), support: 'ready', denied: false, device: false, busy: false, notice: null, ...extra,
})
const view = (state: PushSectionState) => renderToStaticMarkup(
  <PushView state={state} onDevice={() => {}} onKind={() => {}} onThreshold={() => {}} onTest={() => {}} />)
const desktop: DeviceInfo = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', standalone: false, serviceWorker: true, pushManager: true, notification: true,
}
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

describe('push on this device', () => {
  it('asks an iPhone in Safari to add the app to the home screen first', () => {
    expect(pushSupport(desktop)).toBe('ready')
    expect(pushSupport({ ...desktop, userAgent: iphone, pushManager: false })).toBe('install')
    expect(pushSupport({ ...desktop, userAgent: iphone, standalone: true })).toBe('ready')
    // iPad asks for the desktop site: a Mac with a touch screen.
    expect(pushSupport({ ...desktop, userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('install')
    expect(pushSupport({ ...desktop, pushManager: false })).toBe('unsupported')
  })

  it('turns the base64url VAPID key into bytes', () => {
    expect([...serverKey('BAEC_-8')]).toEqual([4, 1, 2, 255, 239])
  })

  it('reads the answer of the server', () => {
    expect(isPushState(push())).toBe(true)
    expect(isPushState(push({ configured: false, public_key: null }))).toBe(true)
    expect(isPushState({ ...push(), settings: { ...push().settings, large: 'yes' } })).toBe(false)
  })
})

describe('«Уведомления» block', () => {
  it('says the server is not set up and hides the rest', () => {
    const html = view(ready({ push: push({ configured: false, public_key: null }) }))
    expect(html).toContain(pushTexts.notConfigured)
    expect(html).not.toContain('data-push-enable')
    expect(html).not.toContain('role="switch"')
  })

  it('offers to switch this device on, the five reasons and the test', () => {
    const html = view(ready())
    expect(html).toContain(pushTexts.enable)
    expect(html).toContain(pushTexts.off)
    for (const title of ['Регулярные платежи', 'Лимиты', 'Итоги недели', 'Разбор месяца', 'Крупные траты семьи']) expect(html).toContain(title)
    expect(html.match(/role="switch"/g)).toHaveLength(5)
    expect(html).toMatch(/aria-checked="false"[^>]*data-push-kind="large"/)
    expect(html).toMatch(/aria-checked="true"[^>]*data-push-kind="weekly"/)
    expect(html).toContain('от 100 000 ₸')
    expect(html).toContain(pushTexts.test)
    expect(html).toContain(pushTexts.quiet)
    expect(html).not.toContain('data-push-threshold')
  })

  it('shows the threshold field when large spends are on, and the device that receives', () => {
    const html = view(ready({ device: true, push: push({ devices: 2, settings: { ...push().settings, large: true, large_threshold: '250000.00' } }) }))
    expect(html).toContain(pushTexts.disable)
    expect(html).toContain(pushTexts.on)
    expect(html).toContain(pushTexts.devices(2))
    expect(html).toContain('value="250000"')
  })

  it('explains the home screen on an iPhone and a refused permission', () => {
    const install = view(ready({ support: 'install' }))
    expect(install).toContain('На экран „Домой“')
    expect(install).not.toContain('data-push-enable')
    expect(view(ready({ denied: true }))).toContain(pushTexts.denied)
  })

  it('uses only tokens for its colours', () => {
    const css = readFileSync(new URL('./Push.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(css).not.toMatch(/font-size:(?!\s*var\(--ck-text-)/)
  })
})
