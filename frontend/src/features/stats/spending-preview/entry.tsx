/* Client entry of the standalone preview bundle; the application never imports it. */
import { hydrateRoot } from 'react-dom/client'
import '../../../App.css'
import '../Spending.css'
import './preview.css'
import SpendingDemo from './demo.tsx'
import type { DemoFixtures } from './demo.tsx'

const root = document.getElementById('root')
const data = document.getElementById('fixtures')?.textContent
if (root && data) hydrateRoot(root, <SpendingDemo fixtures={JSON.parse(data) as DemoFixtures} />)
