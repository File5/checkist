/** Number of category colours (`--ck-cat-1` … `--ck-cat-6` in theme/tokens.css). */
export const categoryTones = 6

/** The colour of a category by its id, 1–6 (`--ck-cat-N`): the same category has the same colour on every screen
 * («Главная», «Траты»). 0 — no category, the neutral colour. */
export function categoryTone(categoryId: number | null | undefined): number {
  if (!categoryId) return 0
  return ((categoryId - 1) % categoryTones + categoryTones) % categoryTones + 1
}
