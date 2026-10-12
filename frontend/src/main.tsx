import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './theme/tokens.css'
import './App.css'
import './components/ActionBar.css'
import { registerServiceWorker } from './offline/service-worker'

// Offline mode (public/sw.js): only a production build; the dev server must never be cached.
if (import.meta.env.PROD) registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
