/** Marks a crop that waits for a person: «Проверить и подтвердить» of the job page leads to the first one. */
export const reviewCropAttribute = 'data-review-crop'
/** Scrolls to the first crop that waits for a person and moves the focus there. */
export function toReviewCrop() {
  const crop = document.querySelector<HTMLElement>(`[${reviewCropAttribute}]`)
  crop?.scrollIntoView({ block: 'start' })
  crop?.focus({ preventScroll: true })
}
