import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupIpcHandlers } from './ipc-handlers'
import { PythonBridge } from './python-bridge'
import { logger, archiveCurrentSession } from './logger'
import { initAutoUpdater } from './updater'
import { syncBuiltinExtensions } from './builtin-sync'
import { reconcileInterruptedExtensionInstalls } from './extension-install-recovery'
import { getSettings } from './settings-store'
import { handleThumbnailProtocol, registerThumbnailScheme } from './asset-thumbnail-protocol'
import { API_TOKEN_HEADER, getApiToken, isApiRequest, isAppNavigation } from './api-auth'

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
      nodeIntegration: false,
      backgroundThrottling: false
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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The window only ever shows Modly's own pages: any other page loaded here
  // would get the API token from the request hook. Links open in the browser.
  const rendererUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const keepOnApp = (event: Electron.Event, url: string) => {
    if (isAppNavigation(url, rendererUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', keepOnApp)
  mainWindow.webContents.on('will-redirect', keepOnApp)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('Modly')
registerThumbnailScheme()

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

app.whenReady().then(async () => {
  archiveCurrentSession()
  logger.info(`App started — version ${app.getVersion()}`)
  electronApp.setAppUserModelId('com.modly.app')

  // Clear Chromium disk cache on startup to recover from any corruption
  await session.defaultSession.clearCache()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  handleThumbnailProtocol()

  // Sync built-in extensions from app resources to userData
  syncBuiltinExtensions()

  // Finish or roll back interrupted extension swaps before the backend scans
  // the extensions directory. This must complete before PythonBridge starts.
  const extensionsDir = getSettings(app.getPath('userData')).extensionsDir
  try {
    await reconcileInterruptedExtensionInstalls(extensionsDir, logger)
  } catch (err) {
    logger.error(`[ext-recovery] Startup reconciliation failed: ${String(err)}`)
  }

  // Start Python FastAPI backend
  pythonBridge = new PythonBridge()
  pythonBridge.setWindowGetter(() => mainWindow)
  setupIpcHandlers(pythonBridge, () => mainWindow)
  initAutoUpdater(() => mainWindow)

  // The backend rejects requests without this launch's token. Adding it here
  // covers every request of the session (axios, fetch, SSE, three.js loaders,
  // downloads) with no change in the renderer. The filter has no port, which
  // matches any port; the backend's port is checked per request because it is
  // only settled once the bridge starts and may change on a restart.
  // A session takes a single onBeforeSendHeaders listener: this is the only one.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
    (details, callback) => {
      const port = pythonBridge?.getPort()
      if (port !== undefined && isApiRequest(details.url, port)) {
        details.requestHeaders[API_TOKEN_HEADER] = getApiToken()
      }
      callback({ requestHeaders: details.requestHeaders })
    },
  )

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
  if (!pythonBridge) return
  event.preventDefault()
  pythonBridge.stop().finally(() => {
    pythonBridge = null
    app.quit()
  })
})
