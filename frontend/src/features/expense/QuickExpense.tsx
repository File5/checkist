import { Link } from '../../navigation'

/** The floating «Добавить трату» of a phone, above «Снять чек»; the stack and its place are in QuickShot.css. */
export default function QuickExpense() {
  return <Link className="ck-quick-expense" to="/receipts/new">Добавить трату</Link>
}
