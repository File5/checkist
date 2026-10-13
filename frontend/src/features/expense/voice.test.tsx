import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TextHintView } from './TextHint'
import { speechRecognition, transcript, voiceError } from './voice'

const result = (text: string, isFinal = false) => ({ isFinal, 0: { transcript: text } })

describe('voice input of a spend', () => {
  it('finds the standard and the Safari recognition, and none in Node', () => {
    class Standard {}
    class Webkit {}
    expect(speechRecognition({ SpeechRecognition: Standard, webkitSpeechRecognition: Webkit })).toBe(Standard)
    expect(speechRecognition({ webkitSpeechRecognition: Webkit })).toBe(Webkit)
    expect(speechRecognition({})).toBeUndefined()
  })
  it('joins what was heard into one line', () => {
    expect(transcript([result('молоко 450 '), result('  хлеб 230', true)])).toBe('молоко 450 хлеб 230')
    expect(transcript([])).toBe('')
  })
  it('explains a refused microphone and keeps quiet on a stop', () => {
    expect(voiceError('not-allowed')).toContain('Разрешите')
    expect(voiceError('no-speech')).toContain('Ничего не услышал')
    expect(voiceError('aborted')).toBeUndefined()
    expect(voiceError('network')).toContain('Введите текст')
  })
  it('shows the mic only where the browser can listen, pressed while listening', () => {
    const view = { kind: 'idle' } as const
    const none = renderToStaticMarkup(<TextHintView text="" view={view} onText={() => {}} onSubmit={() => {}} />)
    expect(none).not.toContain('expense-hint-mic')
    const idle = renderToStaticMarkup(<TextHintView text="" view={view} onText={() => {}} onSubmit={() => {}} voice={{ listening: false, onToggle: () => {} }} />)
    expect(idle).toContain('aria-label="Сказать голосом"')
    expect(idle).toContain('aria-pressed="false"')
    const on = renderToStaticMarkup(<TextHintView text="такси" view={view} onText={() => {}} onSubmit={() => {}} voice={{ listening: true, onToggle: () => {} }} />)
    expect(on).toContain('aria-label="Остановить запись"')
    expect(on).toContain('Слушаю…')
  })
})
