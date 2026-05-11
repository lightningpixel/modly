import React from 'react'
import ReactDOM from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '@shared/i18n/config'
import App from './App'
import '@styles/globals.css'
import '@xyflow/react/dist/style.css'

window.addEventListener('error', (e) => {
  window.electron.log.error(`${e.message} — ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  window.electron.log.error(`Unhandled promise rejection: ${String(e.reason)}`)
})

// Initialize i18n with language preference from settings
window.electron.settings.get().then((settings) => {
  const language = settings.language || 'en'
  i18n.changeLanguage(language)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
)
