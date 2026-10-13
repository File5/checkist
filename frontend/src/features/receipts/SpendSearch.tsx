import { useId, useState } from 'react'
import Icon from '../../components/Icon'
import { Link, navigate } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { askHref } from './spends'
import { applyFilters, filterDraft, filterMessages } from './state'
import type { Failure } from './state'

/** «Траты» (2026-10-13): one line that finds a spend by its place, comment, items or amount — `?q=` of the address,
 * the other filters stay. With text in it — «Спросить», the same words as a question. Emptied, it shows every spend. */
export default function SpendSearch({ query, failure }: { query: ReceiptsQuery; failure?: Failure }) {
  const source = query.q ?? ''
  const [state, setState] = useState({ source, text: source, error: false })
  if (state.source !== source) setState({ source, text: source, error: false })
  const id = useId()
  const text = state.source === source ? state.text : source
  const apply = (value: string) => {
    const result = applyFilters(query, { ...filterDraft(query), q: value.trim() })
    if (result.errors.q) { setState({ source, text: value, error: true }); return }
    navigate({ kind: 'receipts', query: result.query })
  }
  const asked = text.trim()
  // The server refused the words of the address (a character it does not take): said here, where they can be fixed.
  const error = state.error || (failure?.reason === 'invalid_parameter' && Boolean(failure.fields?.includes('q')) && text === source)
  return <form role="search" className="spends-search" noValidate aria-label="Поиск трат"
    onSubmit={(event) => { event.preventDefault(); apply(text) }}>
    <div className="spends-search-line">
      <label className="spends-search-field" htmlFor={`${id}-q`}>
        <Icon name="search" size={20} />
        <span className="spends-hidden">Найти трату</span>
        <input id={`${id}-q`} name="q" type="search" value={text} autoComplete="off" enterKeyHint="search"
          placeholder="Место, комментарий, позиция или сумма" aria-invalid={error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            const value = event.target.value
            setState({ source, text: value, error: false })
            // The cross of the field (or the text erased): the search is over, the list comes back at once.
            if (!value && query.q) apply('')
          }} />
      </label>
      {asked && <Link className="spends-ask" to={askHref(asked)}>Спросить</Link>}
    </div>
    {error && <p className="receipt-field-error" id={`${id}-error`}>{filterMessages.q}</p>}
  </form>
}
