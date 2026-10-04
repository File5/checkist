import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../', import.meta.url))
  const env = loadEnv(mode, envDir, ['DEV_API_PROXY_TARGET', 'VITE_API_BASE_URL'])
  const proxy = {
    '/api': {
      target: env.DEV_API_PROXY_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true,
    },
    '/media': {
      target: env.DEV_API_PROXY_TARGET || 'http://127.0.0.1:8000',
      changeOrigin: true,
    },
  }

  return {
    plugins: [react()],
    envDir,
    // Expose exactly this public setting, rather than every VITE_* variable.
    envPrefix: [],
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(env.VITE_API_BASE_URL || '/api'),
    },
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  }
})
