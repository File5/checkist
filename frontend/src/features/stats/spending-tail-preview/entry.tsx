/* Client entry of the standalone preview bundle; the application never imports it. */
import { createRoot } from 'react-dom/client'
import '../../../theme/tokens.css'
import '../Spending.css'
import '../../../App.css'
import './preview.css'
import SpendingTailDemo from './demo.tsx'
import type { TailFixtures } from './demo.tsx'

const root = document.getElementById('root')
const data = document.getElementById('fixtures')?.textContent
if (root && data) createRoot(root).render(<SpendingTailDemo fixtures={JSON.parse(data) as TailFixtures} />)
