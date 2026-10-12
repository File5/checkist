import { errorMessage } from '../receipts/state'
import type { Failure } from '../receipts/state'

/** A failed save or deletion in words of this screen; field refusals are shown at their fields instead. */
export function saveMessage(failure: Failure): string {
  if (failure.reason === 'receipt_read_only') return 'Чек с фото не меняется: править и удалять можно только трату, внесённую вручную.'
  if (failure.reason === 'invalid_parameter') return 'Проверьте отмеченные поля.'
  if (failure.reason === 'csrf_failed') return 'Сессия обновилась. Повторите действие ещё раз.'
  if (failure.reason === 'not_found') return 'Трата не найдена. Возможно, её уже удалили.'
  return errorMessage(failure)
}
