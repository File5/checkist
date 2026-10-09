/* Client entry of the standalone touch preview bundle; the application never imports it. The screen stylesheet
   comes along on purpose: its `.ck-pie-legend a` rule is the one the 44px legend link has to outweigh. */
import { createRoot } from 'react-dom/client'
import '../../../theme/tokens.css'
import '../../../features/stats/Spending.css'
import '../../../App.css'
import TouchDemo from './touch-demo.tsx'

const root = document.getElementById('root')
if (root) createRoot(root).render(<TouchDemo />)
