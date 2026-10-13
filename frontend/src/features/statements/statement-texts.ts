/** Words of the statement screens and of their refusals. A server message never reaches the screen: only its code. */
import type { LocalApiFailure } from '../../api/types'

export const statementTexts = {
  uploadTitle: 'Выписка из банка',
  uploadIntro: 'Kaspi Gold или ForteBank — PDF из приложения банка за любой период. Траты появятся на вас; знакомые получатели '
    + 'сразу получат категорию, спорные строки покажу отдельно.',
  uploadPrivacy: 'Файл не хранится: остаются только строки черновика и отпечаток файла, чтобы та же выписка не загрузилась дважды.',
  pick: 'Выбрать PDF',
  reading: 'Читаю выписку…',
  reused: 'Эта выписка уже загружена — открываю её черновик.',
  history: 'Загруженные выписки',
  rulesLink: 'Правила получателей',
  rulesIntro: 'Правило решает, что делать со строкой выписки по её получателю. Правила общие для семьи; выученные появляются, '
    + 'когда вы меняете категорию в черновике. «Взнос в цель» — личное: перевод на свой депозит станет взносом, а не тратой.',
  noRules: 'Правил пока нет. Они появятся, когда вы поправите категорию в черновике выписки, — или добавьте своё.',
  modelWaiting: (count: number) => `Спрашиваю модель о незнакомых получателях: ${count}. Можно сохранять, не дожидаясь.`,
  modelAbsent: 'Исполнитель не запущен — модель сейчас не ответит. Выберите категории сами.',
  missing: (count: number) => `Без категории отмечено: ${count}. Выберите категорию или снимите отметку.`,
  deleteQuestion: 'Убрать черновик? Сохранённые из него траты останутся.',
} as const

/** A refused upload, save or rule in words of the screen. */
export function statementFailure(failure: LocalApiFailure): string {
  switch (failure.reason) {
    case 'unsupported_format': case 'unsupported_media_type': return 'Нужен PDF выписки из приложения банка.'
    case 'invalid_pdf': return 'Не удалось прочитать PDF. Скачайте выписку из приложения банка ещё раз.'
    case 'pdf_encrypted': return 'PDF защищён паролем. Сохраните выписку без пароля и загрузите снова.'
    case 'pdf_too_many_pages': case 'statement_too_large': return 'Выписка слишком большая. Выберите период короче.'
    case 'statement_unsupported_bank': return 'Это не выписка Kaspi Gold или ForteBank. Другие банки пока не поддерживаются.'
    case 'statement_empty': return 'В файле не нашлось операций. Нужна выписка по карте за период, в PDF из приложения банка.'
    case 'upload_too_large': return 'Файл слишком большой.'
    case 'not_found': return 'Выписка не найдена. Возможно, её черновик уже убран.'
    case 'invalid_parameter': case 'invalid_request': return 'Не удалось сохранить: проверьте отмеченные строки и попробуйте ещё раз.'
    case 'csrf_failed': return 'Сессия обновилась. Повторите действие ещё раз.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    default: return 'Не получилось. Повторите попытку.'
  }
}
