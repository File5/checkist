/** The grey blocks of a loading state (feature/split-skeletons, 2026-10-13), drawn by RequestState: the shape of what
 * comes, so the screen does not jump when it arrives. Decoration only (`aria-hidden`): the words of the state stay for a
 * screen reader. Static blocks; a gentle pulse only without reduced motion (Skeleton.css).
 *
 *  - `page`   — a card: a title line, a big figure, three rows (any screen);
 *  - `home`   — «Главная»: the card of the month with its figure and bar, the two actions, the latest spends; the
 *               limits beside them on a wide screen;
 *  - `spends` — «Траты»: two days, each a header line over a card of rows;
 *  - compact (inside a card) — two small rows.
 */
export type SkeletonShape = 'page' | 'home' | 'spends'

function Row() {
  return <div className="ck-skel-row">
    <div className="ck-skel-badge" />
    <div className="ck-skel-main"><div className="ck-skel-line ck-skel-w60" /><div className="ck-skel-line ck-skel-small ck-skel-w35" /></div>
    <div className="ck-skel-line ck-skel-amount" />
  </div>
}

function Rows({ count }: { count: number }) {
  return <div className="ck-skel-rows">{Array.from({ length: count }, (_, index) => <Row key={index} />)}</div>
}

/** A row of a limit: the name and the sum over a bar. */
function LimitRow() {
  return <div className="ck-skel-limit">
    <div className="ck-skel-limit-line"><div className="ck-skel-line ck-skel-w45" /><div className="ck-skel-line ck-skel-amount" /></div>
    <div className="ck-skel-bar" />
  </div>
}

/** A field of a form under its label. */
function Labelled() {
  return <div className="ck-skel-labelled"><div className="ck-skel-line ck-skel-small ck-skel-w35" /><div className="ck-skel-field" /></div>
}

/** The top of «Траты» while its script is on its way (App's fallback only): the search field and the row of chips,
 * and the form of filters where a wide screen shows it in the page. */
export function SpendsTopSkeleton() {
  return <div className="ck-skel ck-skel-spends ck-skel-spends-top" data-skeleton="spends-top" aria-hidden="true">
    <div className="ck-skel-field" />
    <div className="ck-skel-chip" />
    <div className="ck-skel-card ck-skel-filters">
      <div className="ck-skel-line ck-skel-w30" />
      <div className="ck-skel-pair"><Labelled /><Labelled /></div>
      <div className="ck-skel-line ck-skel-small ck-skel-w60" />
      <div className="ck-skel-pair"><Labelled /><Labelled /></div>
      <div className="ck-skel-action ck-skel-button" />
    </div>
  </div>
}

export default function Skeleton({ shape = 'page', compact = false }: { shape?: SkeletonShape; compact?: boolean }) {
  if (compact) {
    return <div className="ck-skel ck-skel-compact" data-skeleton="compact" aria-hidden="true">
      <div className="ck-skel-line ck-skel-w80" /><div className="ck-skel-line ck-skel-w60" />
    </div>
  }
  if (shape === 'home') {
    return <div className="ck-skel ck-skel-home" data-skeleton="home" aria-hidden="true">
      <div className="ck-skel-column">
        <div className="ck-skel-card ck-skel-hero">
          <div className="ck-skel-split"><div className="ck-skel-line ck-skel-w35" /><div className="ck-skel-line ck-skel-amount" /></div>
          <div className="ck-skel-figure ck-skel-hero-figure ck-skel-w60" />
          <div className="ck-skel-line ck-skel-small ck-skel-w45" />
          <div className="ck-skel-bar" />
          <div className="ck-skel-line ck-skel-small ck-skel-w80" />
          <div className="ck-skel-split ck-skel-ruled"><div className="ck-skel-line ck-skel-w45" /><div className="ck-skel-figure ck-skel-amount" /></div>
          <div className="ck-skel-line ck-skel-small ck-skel-w60" />
        </div>
        <div className="ck-skel-actions"><div className="ck-skel-action" /><div className="ck-skel-action" /></div>
        <div className="ck-skel-card ck-skel-recent"><div className="ck-skel-line ck-skel-w45" /><Rows count={4} /></div>
      </div>
      <div className="ck-skel-column ck-skel-side">
        <div className="ck-skel-card"><div className="ck-skel-line ck-skel-w35" /><LimitRow /><LimitRow /><LimitRow /></div>
      </div>
    </div>
  }
  if (shape === 'spends') {
    return <div className="ck-skel ck-skel-spends" data-skeleton="spends" aria-hidden="true">
      {[3, 2].map((count) => <div key={count} className="ck-skel-day">
        <div className="ck-skel-day-head"><div className="ck-skel-line ck-skel-small ck-skel-w30" /><div className="ck-skel-line ck-skel-small ck-skel-amount" /></div>
        <div className="ck-skel-card ck-skel-list"><Rows count={count} /></div>
      </div>)}
    </div>
  }
  return <div className="ck-skel ck-skel-page" data-skeleton="page" aria-hidden="true">
    <div className="ck-skel-line ck-skel-w35" />
    <div className="ck-skel-figure ck-skel-w55" />
    <Rows count={3} />
  </div>
}
