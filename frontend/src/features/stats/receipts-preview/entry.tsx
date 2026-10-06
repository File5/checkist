/* Client entry of the standalone preview bundle; the application never imports it. */
import { createRoot } from 'react-dom/client'
import '../../../App.css'
import '../ReceiptsStats.css'
import ReceiptsStatsDemo from './demo.tsx'

// The page has no application behind it: links must not change its address.
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('a')) { event.preventDefault(); event.stopPropagation() }
}, true)
const root = document.getElementById('root')
if (root) createRoot(root).render(<ReceiptsStatsDemo />)
