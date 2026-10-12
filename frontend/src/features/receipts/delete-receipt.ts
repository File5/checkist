import type { Failure } from './state'
import { errorMessage } from './state'

/** The inline deletion of a photo receipt; `withPhoto` is the «Удалить и фото» checkbox, on by default. */
export type ReceiptDeleteStep =
  | { kind: 'idle' }
  | { kind: 'confirm'; withPhoto: boolean }
  | { kind: 'deleting'; withPhoto: boolean }
  | { kind: 'failed'; withPhoto: boolean; message: string }

export const deleteQuestion = 'Удалить этот чек? Строки чека удалятся, отменить удаление нельзя.'
export const withPhotoLabel = 'Удалить и фото'
export const withPhotoHint = 'Вместе с фото удалятся задания распознавания и вырезки. Без отметки они останутся в «Обработке».'

export function askDelete(): ReceiptDeleteStep {
  return { kind: 'confirm', withPhoto: true }
}

/** The checkbox changes only the confirmation being asked; a running deletion keeps its choice. */
export function toggleWithPhoto(step: ReceiptDeleteStep, withPhoto: boolean): ReceiptDeleteStep {
  return step.kind === 'confirm' || step.kind === 'failed' ? { kind: 'confirm', withPhoto } : step
}

/** Text of a refused deletion; the texts of the server never reach the screen. */
export function deleteFailureMessage(failure: Failure): string {
  switch (failure.reason) {
    case 'job_active': return 'Фото этого чека ещё распознаётся. Дождитесь окончания задания или отмените его в «Обработке».'
    case 'photo_shared': return 'Из этого фото есть и другой чек. Снимите отметку «Удалить и фото», чтобы удалить только этот чек.'
    case 'csrf_failed': return 'Сессия обновилась. Повторите действие ещё раз.'
    default: return errorMessage(failure)
  }
}

/** The notice of «Чеки» after the deletion. */
export function deletedNotice(withPhoto: boolean): string {
  return withPhoto ? 'Чек удалён вместе с фото.' : 'Чек удалён. Фото и его задание остались в «Обработке».'
}

// One notice for the next visit of «Чеки», like the notice of a saved spend.
let notice: string | undefined
export function setReceiptsNotice(message: string) { notice = message }
export function getReceiptsNotice(): string | undefined { return notice }
export function clearReceiptsNotice() { notice = undefined }
