import type { ReceiptImageStatus, RecognitionIssue } from '../api/recognition'
import { groupIssues } from '../lib/recognition-issues'
import type { IssueGroup } from '../lib/recognition-issues'

function GroupBody({ group }: { group: IssueGroup }) {
  return <>
    {group.explanation && <p className="rec-issues-note">{group.explanation}</p>}
    {group.locations.map((text) => <p className="rec-issues-note" key={text}>{text}</p>)}
  </>
}

/** Grouped issues of one receipt crop for the job screen and the receipt card.
 * Server `message` and private requisite values are never rendered.
 */
export default function RecognitionIssues({ issues, status }: { issues: RecognitionIssue[]; status: ReceiptImageStatus }) {
  const groups = groupIssues(issues, status)
  const errors = groups.filter((group) => group.severity === 'error')
  const notes = groups.filter((group) => group.severity !== 'error')
  if (groups.length === 0) return null
  return <div className="rec-issues">
    {errors.length > 0 && <div className="rec-issues-block rec-issues-errors">
      <h4>{status === 'failed' ? 'Причины ошибки' : 'Причины проверки'}</h4>
      <ul className="rec-issues-list">{errors.map((group) => <li key={group.key}>
        <p className="rec-issues-title">{group.title}</p>
        <GroupBody group={group} />
      </li>)}</ul>
    </div>}
    {notes.length > 0 && <div className="rec-issues-block">
      <h4>Замечания распознавания</h4>
      <ul className="rec-issues-list">{notes.map((group) => <li key={group.key}>
        {group.explanation || group.locations.length > 0
          ? <details><summary>{group.title}</summary><GroupBody group={group} /></details>
          : <p className="rec-issues-title">{group.title}</p>}
      </li>)}</ul>
    </div>}
  </div>
}
