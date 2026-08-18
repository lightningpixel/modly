import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { setupIpcHandlers } from './ipc-handlers'
import { PythonBridge } from './python-bridge'
import { logger, archiveCurrentSession } from './logger'
import { initAutoUpdater } from './updater'
import { syncBuiltinExtensions } from './builtin-sync'
import { reconcileInterruptedExtensionInstalls } from './extension-install-recovery'
import { getSettings } from './settings-store'

let mainWindow: BrowserWindow | null = null
let pythonBridge: PythonBridge | null = null

// When the launching terminal closes, stdout/stderr become broken pipes and
// every console.* write emits an unhandled 'error' (EPIPE) that would loop
// through the uncaughtException handler forever. Swallow stream errors.
process.stdout?.on('error', () => {})
process.stderr?.on('error', () => {})

// UI zoom: Ctrl/Cmd with + / - / 0 scales the whole window like a browser,
// clamped to a sane range and persisted across restarts. This is done at the
// Chromium level (not CSS) so pointer math in the 3D viewport stays correct.
const ZOOM_MIN = -2
const ZOOM_MAX = 4

function zoomFilePath(): string {
  return join(app.getPath('userData'), 'ui-zoom.json')
}

function loadZoomLevel(): number {
  try {
    const saved = JSON.parse(readFileSync(zoomFilePath(), 'utf-8')) as { level?: number }
    return typeof saved.level === 'number' ? saved.level : 0
  } catch {
    return 0
  }
}

function saveZoomLevel(level: number): void {
  try {
    writeFileSync(zoomFilePath(), JSON.stringify({ level }), 'utf-8')
  } catch (err) {
    logger.error(`Failed to persist UI zoom level: ${err}`)
  }
}

function clampZoomLevel(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))
}

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

    const isZoomChord = input.type === 'keyDown' && (input.control || input.meta) && !input.alt
    if (!isZoomChord) return

    const wc = mainWindow?.webContents
    if (!wc) return

    if (input.key === '+' || input.key === '=') {
      event.preventDefault()
      const level = clampZoomLevel(wc.getZoomLevel() + 0.5)
      wc.setZoomLevel(level)
      saveZoomLevel(level)
    } else if (input.key === '-' || input.key === '_') {
      event.preventDefault()
      const level = clampZoomLevel(wc.getZoomLevel() - 0.5)
      wc.setZoomLevel(level)
      saveZoomLevel(level)
    } else if (input.key === '0') {
      event.preventDefault()
      wc.setZoomLevel(0)
      saveZoomLevel(0)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const level = loadZoomLevel()
    if (level) mainWindow?.webContents.setZoomLevel(level)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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

app.whenReady().then(async () => {
  archiveCurrentSession()
  logger.info(`App started — version ${app.getVersion()}`)
  electronApp.setAppUserModelId('com.modly.app')

  // Clear Chromium disk cache on startup to recover from any corruption
  await session.defaultSession.clearCache()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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
