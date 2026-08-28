import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { logger } from './logger'

type WindowGetter = () => BrowserWindow | null

// macOS builds are not signed with a Developer ID (no Apple licence).
// electron-updater validates the bundle's signature before applying an update,
// so on darwin it would fail every time, in a loop every 2 hours. Mac users
// therefore update manually from the GitHub releases.
export const updatesSupported = process.platform !== 'darwin'

export function initAutoUpdater(getWindow: WindowGetter): void {
  if (!updatesSupported) {
    logger.info('[updater] Disabled on macOS (unsigned build) — manual updates only')
    return
  }

  autoUpdater.logger = logger as any
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('update-available', (info) => {
    const running  = app.getVersion()
    const incoming = info.version
    const [rMaj, rMin] = running.split('.').map(Number)
    const [iMaj, iMin] = incoming.split('.').map(Number)
    const isPatch = rMaj === iMaj && rMin === iMin

    if (isPatch) {
      logger.info(`[updater] Patch ${incoming} available — downloading`)
      autoUpdater.downloadUpdate().catch((err: Error) => {
        logger.error(`[updater] Download failed: ${err.message}`)
      })
    } else {
      logger.info(`[updater] Major/minor update ${incoming} available — notifying renderer`)
      getWindow()?.webContents.send('updater:major-minor-available', { version: incoming })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`[updater] Patch ${info.version} downloaded — applying now`)
    getWindow()?.webContents.send('updater:applying', { version: info.version })
    // Small delay so the renderer can render the "Applying…" panel before quit
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true)
    }, 800)
  })

  autoUpdater.on('update-not-available', () => {
    logger.info('[updater] App is up to date')
  })

  autoUpdater.on('error', (err: Error) => {
    logger.error(`[updater] Error: ${err.message}`)
  })

  // Check immediately on startup so it can apply during the setup screen
  autoUpdater.checkForUpdates().catch((err: Error) => {
    logger.error(`[updater] Initial check failed: ${err.message}`)
  })

  // Re-check every 2 hours for long-running sessions
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 2 * 60 * 60 * 1000)
}
