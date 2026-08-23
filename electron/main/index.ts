import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupIpcHandlers } from './ipc-handlers'
import { API_BASE_URL, PythonBridge } from './python-bridge'
import { logger, archiveCurrentSession } from './logger'
import { initAutoUpdater } from './updater'
import { syncBuiltinExtensions } from './builtin-sync'
import { API_TOKEN_HEADER, getApiToken, removeApiTokenFile } from './api-token'
import { isSafeExternalUrl } from './external-links'

let mainWindow: BrowserWindow | null = null
let pythonBridge: PythonBridge | null = null

// When the launching terminal closes, stdout/stderr become broken pipes and
// every console.* write emits an unhandled 'error' (EPIPE) that would loop
// through the uncaughtException handler forever. Swallow stream errors.
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#111113',
    titleBarStyle: 'hidden',
    icon: join(__dirname, '../../resources/icons/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Keep the renderer's maximize/restore icon in sync — covers the toolbar
  // button, double-clicking the title bar, and OS window-snap gestures.
  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window:maximizeChanged', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximizeChanged', false))

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isMacQuitShortcut =
      process.platform === 'darwin' &&
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'q' &&
      input.meta &&
      !input.control &&
      !input.alt

    if (isMacQuitShortcut) {
      event.preventDefault()
      app.quit()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // A new window opens in the browser (above); the app's own window must stay
  // on the app. Nothing navigates it today, but if anything ever did - a link
  // with target=_self, a URL dropped onto the window - the page that replaced
  // it would inherit this window's preload bridge and this session, which the
  // main process stamps the API token onto. External pages open externally.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = is.dev && process.env['ELECTRON_RENDERER_URL']
      ? url.startsWith(process.env['ELECTRON_RENDERER_URL'])
      : url.startsWith('file://')
    if (allowed) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) shell.openExternal(url)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('Modly')

process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
  logger.error(`Uncaught exception: ${err.stack ?? err.message}`)
  mainWindow?.webContents.send('app:error', err.stack ?? err.message)
})

process.on('unhandledRejection', (reason) => {
  const msg = String(reason)
  logger.error(`Unhandled rejection: ${msg}`)
  mainWindow?.webContents.send('app:error', msg)
})

/**
 * Stamp the API token onto every request the renderer makes to the backend.
 *
 * Done here rather than at each call site: the renderer reaches the API through
 * plain fetch(), EventSource and <img>/<video> src attributes as well, and none
 * of those can carry a header of their own. Intercepting the session covers all
 * of them at once, which is also why the renderer code needs no notion of the
 * token existing.
 */
function attachApiToken(): void {
  const urls = [`${API_BASE_URL}/*`, `${API_BASE_URL.replace('127.0.0.1', 'localhost')}/*`]
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [API_TOKEN_HEADER]: getApiToken() } })
  })
}

app.whenReady().then(async () => {
  archiveCurrentSession()
  logger.info(`App started — version ${app.getVersion()}`)
  electronApp.setAppUserModelId('com.modly.app')

  // Clear Chromium disk cache on startup to recover from any corruption
  await session.defaultSession.clearCache()

  attachApiToken()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Sync built-in extensions from app resources to userData
  syncBuiltinExtensions()

  // Start Python FastAPI backend
  pythonBridge = new PythonBridge()
  pythonBridge.setWindowGetter(() => mainWindow)
  setupIpcHandlers(pythonBridge, () => mainWindow)
  initAutoUpdater(() => mainWindow)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Modly holds a multi-GB Python subprocess; leaving it running in the
  // Dock after the window closes (the Mac default) is the wrong behavior
  // for this app. Closing the window means quit.
  app.quit()
})

app.on('before-quit', (event) => {
  // The token is per-launch: a file left behind names a secret that is no
  // longer valid, and the next launch would have to overwrite it anyway.
  removeApiTokenFile()
  if (!pythonBridge) return
  event.preventDefault()
  pythonBridge.stop().finally(() => {
    pythonBridge = null
    app.quit()
  })
})
