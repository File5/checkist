// Voice input for «Скажите словами»: the browser's own speech recognition (Safari on iPhone, Chrome on Android).
// ponytail: Web Speech API only; where the browser has none, the mic is hidden and the keyboard's dictation key still works.

type Alternative = { transcript: string }
type Result = { isFinal: boolean; 0: Alternative }
export type SpeechEvent = { results: ArrayLike<Result> }
export type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((event: SpeechEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionClass = new () => Recognition

export function speechRecognition(scope: object = globalThis): RecognitionClass | undefined {
  const found = scope as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }
  return found.SpeechRecognition ?? found.webkitSpeechRecognition
}

/** Everything heard so far, interim words included, as one line. */
export function transcript(results: ArrayLike<Result>) {
  return Array.from(results, (result) => result[0].transcript).join(' ').replace(/\s+/g, ' ').trim()
}

/** Why recognition stopped, in words for the person; `undefined` — nothing worth saying. */
export function voiceError(code: string) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Нет доступа к микрофону. Разрешите его в настройках браузера или введите текст.'
  if (code === 'no-speech') return 'Ничего не услышал. Нажмите на микрофон и скажите ещё раз.'
  if (code === 'aborted') return undefined
  return 'Голосовой ввод не сработал. Введите текст.'
}
