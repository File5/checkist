import Icon from '../../components/Icon'
import ListIconsToggle from '../../components/ListIconsToggle'
import { Link } from '../../navigation'
import type { Route } from '../../navigation'
import { initials, personName } from '../../lib/people'
import { menuItems } from '../../menu/menu-items'
import type { MenuItem } from '../../menu/menu-items'
import { useSession } from '../../session'
import { ThemeToggle } from '../../theme'
import './More.css'

const MORE: Route = { kind: 'more' }

function Row({ entry }: { entry: MenuItem }) {
  return <li>
    <Link className="ck-row more-row" to={entry.to}>
      <span className="ck-row-badge more-badge" aria-hidden="true"><Icon name={entry.icon} size={20} /></span>
      <span className="ck-row-main"><span className="ck-row-title">{entry.label}</span></span>
      <Icon name="forward" size={18} className="ck-icon more-chevron" />
    </Link>
  </li>
}

/**
 * «Ещё» of a phone as a screen of its own (2026-10-13, «на весь экран, как в приложении»): the person and the family
 * on top, «Деньги» as four tiles, then «Данные» and «Настройки» with the theme and the pictures of the spends. The
 * bottom bar stays, «Ещё» marked; a section opened from here goes back here (`menu/back-target.ts`). A wide screen
 * keeps its header lists, the address still works there.
 */
export default function MorePage() {
  const session = useSession()
  const { groups } = menuItems(session, MORE)
  const account = groups.flatMap((group) => group.items).find((entry) => entry.account)
  const name = session.kind === 'user' ? personName(session.user.username, session.user.display_name) : ''
  const family = session.kind === 'user' ? session.household?.name : undefined
  return <div className="more ck-stack">
    {account && <Link className="ck-panel more-profile" to={account.to} aria-label={`Аккаунт: ${name}`}>
      <span className="more-avatar" aria-hidden="true">{initials(name)}</span>
      <span className="ck-row-main">
        <span className="more-profile-name">{name}</span>
        <span className="ck-row-meta">{family ? `Семья «${family}» · пароль и уведомления` : 'Пароль и уведомления'}</span>
      </span>
      <Icon name="forward" size={18} className="ck-icon more-chevron" />
    </Link>}
    {groups.map((group) => group.key === 'money'
      ? <section key={group.key} aria-label={group.title}>
        <ul className="more-tiles">{group.items.map((entry) => <li key={entry.key}>
          <Link className="more-tile" to={entry.to}><Icon name={entry.icon} size={24} />{entry.label}</Link>
        </li>)}</ul>
      </section>
      : <section key={group.key} className="ck-panel more-section" aria-labelledby={`more-${group.key}`}>
        <h2 id={`more-${group.key}`} className="more-title">{group.title}</h2>
        <ul className="ck-list">{group.items.filter((entry) => !entry.account).map((entry) => <Row key={entry.key} entry={entry} />)}</ul>
        {group.key === 'settings' && <div className="more-toggles"><ThemeToggle placement="menu" /><ListIconsToggle /></div>}
      </section>)}
  </div>
}
