/* Client entry of the standalone legend preview bundle; the application never imports it. The screen stylesheet
   comes along on purpose: its `.ck-pie-legend a` rule is the one the toggle link has to live with. */
import { createRoot } from 'react-dom/client'
import '../../../theme/tokens.css'
import '../../../features/stats/Spending.css'
import '../../../App.css'
import LegendDemo from './legend-demo.tsx'

const root = document.getElementById('root')
if (root) createRoot(root).render(<LegendDemo />)
