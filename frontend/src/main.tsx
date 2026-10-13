// First: every stylesheet in the order of the cascade (styles.ts); the screens come later, in parts (screens.ts).
import './styles'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './offline/service-worker'

// Offline mode (public/sw.js): only a production build; the dev server must never be cached.
if (import.meta.env.PROD) registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
