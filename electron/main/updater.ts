import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { logger } from './logger'

type WindowGetter = () => BrowserWindow | null

// Les builds macOS ne sont pas signés avec un Developer ID (pas de licence Apple).
// electron-updater valide la signature du bundle avant d'appliquer une mise à
// jour : sur darwin il échouerait systématiquement, en boucle toutes les 2 h.
// Les utilisateurs mac mettent donc à jour manuellement via les releases GitHub.
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
