import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { getStatements, uploadStatement } from '../../api/statements'
import type { StatementSummary } from '../../api/statements'
import Icon from '../../components/Icon'
import { Link, navigate } from '../../navigation'
import { historyMeta } from './statement-state'
import { statementFailure, statementTexts } from './statement-texts'
import './Statements.css'

export type UploadState = { kind: 'idle' } | { kind: 'reading' } | { kind: 'failed'; message: string }

export type UploadStatementViewProps = { state: UploadState; history: StatementSummary[]; onFile: (file: File) => void }

/** The screen without the network: the markup tests render it directly. */
export function UploadStatementView({ state, history, onFile }: UploadStatementViewProps) {
  const reading = state.kind === 'reading'
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onFile(file)
  }
  return <div className="statements ck-stack">
    <section className="ck-panel statement-upload" aria-labelledby="statement-upload-heading" aria-busy={reading}>
      <div className="statement-upload-badge" aria-hidden="true"><Icon name="statement" size={28} /></div>
      <h2 id="statement-upload-heading">{statementTexts.uploadTitle}</h2>
      <p className="statement-note">{statementTexts.uploadIntro}</p>
      <label className={`statement-pick${reading ? ' statement-pick-busy' : ''}`}>
        <input type="file" className="statement-file" accept="application/pdf,.pdf" disabled={reading} onChange={change}
          aria-describedby="statement-upload-status" />
        <Icon name="statement" size={20} />
        <span>{reading ? statementTexts.reading : statementTexts.pick}</span>
      </label>
      <p id="statement-upload-status" className={`statement-status${state.kind === 'failed' ? ' statement-status-error' : ''}`}
        role={state.kind === 'failed' ? 'alert' : 'status'}>{state.kind === 'failed' ? state.message : reading ? statementTexts.reading : ''}</p>
      <p className="statement-note statement-small">{statementTexts.uploadPrivacy}</p>
    </section>
    {history.length > 0 && <section className="ck-panel" aria-labelledby="statement-history-heading">
      <div className="ck-panel-head"><h2 id="statement-history-heading">{statementTexts.history}</h2></div>
      <ul className="ck-list">
        {history.map((item) => <li key={item.id}>
          <Link className="ck-row statement-history-row" to={`/statements/${item.id}`}>
            <span className="ck-row-badge statement-bank-badge" data-bank={item.bank} aria-hidden="true">{item.bank === 'forte' ? 'F' : 'K'}</span>
            <span className="ck-row-main"><span className="ck-row-title">{item.bank_name}</span><span className="ck-row-meta">{historyMeta(item)}</span></span>
            <Icon name="forward" size={18} />
          </Link>
        </li>)}
      </ul>
    </section>}
    <Link className="statement-rules-link" to="/statements/rules">{statementTexts.rulesLink}<Icon name="forward" size={18} /></Link>
  </div>
}

/** «Загрузить выписку»: the PDF goes to the server, its draft opens. */
export default function UploadStatementPage() {
  const [state, setState] = useState<UploadState>({ kind: 'idle' })
  const [history, setHistory] = useState<StatementSummary[]>([])
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => {
    const abort = new AbortController()
    void getStatements({ page_size: 20 }, { signal: abort.signal }).then((result) => {
      if (result.kind === 'ok') setHistory(result.data.results)
    })
    return () => { abort.abort(); controller.current?.abort() }
  }, [])
  const upload = async (file: File) => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setState({ kind: 'reading' })
    const result = await uploadStatement(file, { signal: current.signal })
    if (current.signal.aborted || result.kind === 'aborted') return
    if (result.kind === 'error') { setState({ kind: 'failed', message: statementFailure(result) }); return }
    navigate(`/statements/${result.data.statement.id}`)
  }
  return <UploadStatementView state={state} history={history} onFile={(file) => { void upload(file) }} />
}
