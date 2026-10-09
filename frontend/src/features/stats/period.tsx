import { formatPurchasedOn } from '../../lib/format'
import { dateRange } from '../../lib/text'

/** What `dateRange` puts between two dates: the non-breaking space, the only dash of a period and a space. */
const between = dateRange('', '')

/** One day of a period, «01.09.2026»: inside `<time>` the date is never torn. */
export function PeriodDate({ date }: { date: string }) {
  return <time dateTime={date}>{formatPurchasedOn(date)}</time>
}

/** «01.09.2026 — 30.09.2026»: the dash never starts a line, the second date moves to the next line as a whole. */
export function DateRange({ from, to }: { from: string; to: string }) {
  return <><PeriodDate date={from} />{between}<PeriodDate date={to} /></>
}

/** The period an answer was counted for, as the server understood it; an absent bound is an open end. */
export function PeriodText({ period }: { period: { date_from: string | null; date_to: string | null } }) {
  const { date_from: from, date_to: to } = period
  if (from && to) return <>Период: <DateRange from={from} to={to} />, обе даты включительно.</>
  if (from) return <>Период: с <PeriodDate date={from} /> включительно.</>
  if (to) return <>Период: по <PeriodDate date={to} /> включительно.</>
  return <>Период: всё время.</>
}
