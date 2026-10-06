/* Client entry of the standalone preview bundle; the application never imports it. */
import { createRoot } from 'react-dom/client'
import '../../../App.css'
import PriceChartDemo from './demo.tsx'

const root = document.getElementById('root')
if (root) createRoot(root).render(<PriceChartDemo />)
