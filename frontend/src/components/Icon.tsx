/** Line icons of the artifact design (2026-10-13): a 24 × 24 grid, a 2 px stroke in the colour of the text. */
const tag = <><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><path d="M7 7h.01" /></>
const paths = {
  home: <path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  stats: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>,
  pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  receipt: <><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" /><path d="M9 7h6M9 11h6M9 15h4" /></>,
  back: <path d="M15 18l-6-6 6-6" />,
  forward: <path d="M9 18l6-6-6-6" />,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  catalog: tag,
  store: <><path d="M3 9l1.5-5h15L21 9" /><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M5 13v8h14v-8M10 21v-5h4v5" /></>,
  jobs: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /></>,
  export: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  health: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  family: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
  account: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  login: <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  repeat: <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />,
  statement: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
  insight: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  income: <path d="M23 6l-9.5 9.5-5-5L1 18M17 6h6v6" />,
  goal: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  trash: <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />,
  down: <path d="M6 9l6 6 6-6" />,
  check: <path d="M20 6L9 17l-5-5" />,
  filter: <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />,
  // How a spend came in (beside `receipt` and `pencil`): a bank card of a statement.
  card: <><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /><path d="M2 10h20M6 15h4" /></>,
  // Pictures of categories (catalog.CategoryIcon of the server; `home` is above): lib/category-icons.ts.
  cart: <><path d="M2 3h3l2.6 11.2a1 1 0 0 0 1 .8h9a1 1 0 0 0 1-.8L20.5 7H6" /><circle cx="9" cy="19.5" r="1.5" /><circle cx="17" cy="19.5" r="1.5" /></>,
  bus: <><rect x="5" y="3" width="14" height="15" rx="2" /><path d="M5 11h14M9 6h6M7.5 18v2.5M16.5 18v2.5M8.5 14.5h.01M15.5 14.5h.01" /></>,
  car: <><path d="M5 17H3v-4l2.2-5.1A2 2 0 0 1 7 7h10a2 2 0 0 1 1.8 1.1L21 13v4h-2M3 13h18M9 17h6" /><circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" /></>,
  dining: <path d="M6 3v6a3 3 0 0 0 6 0V3M9 3v18M18 21V3c-2 1-3 3.5-3 6.5V14h3" />,
  phone: <><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></>,
  heart: <path d="M12 20L4.3 12.2A4.5 4.5 0 1 1 12 9a4.5 4.5 0 1 1 7.7 3.2z" />,
  shirt: <path d="M9 3c0 1.5 1.3 2.5 3 2.5s3-1 3-2.5l5 2.5-1.5 4.5-2.5-1V21H8V9l-2.5 1L4 5.5z" />,
  ticket: <><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" /><path d="M14 5v2M14 11v2M14 17v2" /></>,
  gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8S10.5 3.5 8 3.5a2.25 2.25 0 0 0 0 4.5M12 8s1.5-4.5 4-4.5a2.25 2.25 0 0 1 0 4.5" /></>,
  baby: <><circle cx="12" cy="13.5" r="6.5" /><path d="M7.4 8.9a2.5 2.5 0 1 1 3-2.8M16.6 8.9a2.5 2.5 0 1 0-3-2.8M9.5 12.5h.01M14.5 12.5h.01M10.5 16a2 2 0 0 0 3 0" /></>,
  box: <path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" />,
  bank: <path d="M3 21h18M4 18h16M6 11v7M10 11v7M14 11v7M18 11v7M12 3l9 5H3z" />,
  beauty: <><circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.2 15.9L18 3M15.8 15.9L6 3" /></>,
  plane: <path d="M10.5 4.5a1.5 1.5 0 0 1 3 0V10l7 4v2l-7-2v4l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-4l-7 2v-2l7-4z" />,
  book: <path d="M5 19.5V4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5 1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6" />,
  paw: <><path d="M12 12c-3 0-6 4-6 6.5 0 1.5 1.2 2.5 2.7 2.5 1.3 0 2.1-.8 3.3-.8s2 .8 3.3.8c1.5 0 2.7-1 2.7-2.5C18 16 15 12 12 12z" /><circle cx="5" cy="10" r="1.5" /><circle cx="9" cy="5.5" r="1.5" /><circle cx="15" cy="5.5" r="1.5" /><circle cx="19" cy="10" r="1.5" /></>,
  tag,
} as const

export type IconName = keyof typeof paths

/** A picture beside a word: hidden from the screen reader, the word names the control. */
export default function Icon({ name, size = 22, className = 'ck-icon' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
