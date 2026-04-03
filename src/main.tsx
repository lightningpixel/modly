import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@styles/globals.css'
import '@xyflow/react/dist/style.css'

window.addEventListener('error', (e) => {
  window.electron.log.error(`${e.message} — ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  window.electron.log.error(`Unhandled promise rejection: ${String(e.reason)}`)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
