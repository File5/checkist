import { useReducer, useState } from 'react'
import { getCountries } from '../../api/countries'
import type { ReceiptImage } from '../../api/recognition'
import RecognitionIssues from '../../components/RecognitionIssues'
import ReviewForm from './ReviewForm'
import { refusalText } from './review-actions'
import type { ReviewActionState } from './review-actions'
import { buildInput, createReview, missingRequired, reviewReducer } from './review-state'
import type { ReviewControl } from './useReviewActions'
import { useRequest } from './useRequest'

const loadCountries = (signal: AbortSignal) => getCountries({ all: true }, { signal })

/** Causes and the correction form of one needs_review crop. The form is created once from normalized_result
 * and then belongs to the person: later reads of the same crop never overwrite what was typed.
 */
export default function ReviewResult({ image, finished, busy, review, remember }: {
  image: ReceiptImage; finished: boolean; busy: boolean; review: ReviewControl; remember: () => void
}) {
  const [state, dispatch] = useReducer(reviewReducer, image, (item) => createReview(item.normalized_result, item.issues))
  const countries = useRequest(loadCountries)
  const saving = review.state.kind === 'pending'
  const pending = review.state.kind === 'pending' && review.state.imageId === image.id
  // The refusal that a later press stopped by the local check replaced: «Запрос не отправлен…» is then the only text at the button.
  const [superseded, setSuperseded] = useState<ReviewActionState | null>(null)
  const confirm = () => {
    if (saving) return
    const missing = missingRequired(state)
    if (Object.keys(missing).length > 0) { setSuperseded(review.state); dispatch({ type: 'missing', problems: missing }); return }
    const { input, sent } = buildInput(state)
    remember()
    // Before «Сохраняем чек…»: the request is being sent, so the text of a stopped press is no longer true.
    dispatch({ type: 'sent' })
    // The refusal is tied to the rows as they were sent, even if the person keeps editing afterwards.
    void review.run(image.id, input).then((error) => { if (error) dispatch({ type: 'refused', error, sent }) })
  }
  const unavailable = !finished ? 'Задание ещё не завершено: подтверждение станет доступно после окончания обработки. Править поля можно уже сейчас.'
    : busy ? 'Выполняется другое действие с заданием. Дождитесь его результата.'
      : saving && !pending ? 'Сохраняется другой чек этого задания. Дождитесь результата.' : undefined
  return <>
    <RecognitionIssues issues={state.issues} status="needs_review" />
    {image.normalized_result === null && <p className="ck-rec-warning">Распознанные данные недоступны. Заполните чек вручную по изображению.</p>}
    <ReviewForm imageId={image.id} state={state} dispatch={dispatch} pending={pending} unavailable={unavailable} onConfirm={confirm}
      refusal={refusalText(review.state, image.id, superseded)}
      countries={countries.state.kind === 'ok' ? countries.state.data.results : null} countriesFailed={countries.state.kind === 'error'} onCountriesRetry={countries.request.refresh} />
  </>
}
