import { app, BrowserWindow, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TextureWatchService } from '../electron/main/texture-watch-service'

const texturePath = process.env.MODLY_TEXTURE_PROOF_FILE
const rendererUrl = process.env.MODLY_TEXTURE_PROOF_URL ?? 'http://127.0.0.1:4177'
if (!texturePath) throw new Error('MODLY_TEXTURE_PROOF_FILE is required')

const service = new TextureWatchService()

app.setName('Texture update proof')
app.setPath('userData', join(__dirname, 'user-data'))

app.whenReady().then(() => {
  ipcMain.handle('texture:chooseAndWatch', async (event) => {
    console.log('[proof] choose requested')
    const update = await service.start(event.sender.id, texturePath, (next) => {
      if (!event.sender.isDestroyed()) event.sender.send('texture:changed', next)
    })
    console.log(`[proof] initial texture state: ${update.state}`)
    return { cancelled: false, update }
  })
  ipcMain.handle('texture:stopWatching', (event) => service.stop(event.sender.id))

  const win = new BrowserWindow({
    width: 960,
    height: 720,
    show: false,
    title: 'Texture update proof',
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(__dirname, '../out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.webContents.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    const message = typeof first === 'object' && first && 'message' in first
      ? String(first.message)
      : String(args[1] ?? first)
    console.log(`[proof] ${message}`)
  })
  const captureNames: Record<string, string> = {
    F6: '01-before.png',
    F7: '02-after.png',
    F8: '03-malformed.png',
    F9: '04-recovered.png',
  }
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault()
      void win.webContents.executeJavaScript(
        "document.querySelector('[data-testid=\"watch-texture-button\"]')?.click()",
      )
      return
    }
    const name = captureNames[input.key]
    if (input.type !== 'keyDown' || !name) return
    event.preventDefault()
    void win.webContents.capturePage().then(async (image) => {
      await writeFile(join(__dirname, name), image.toPNG())
      console.log(`[proof] captured ${name}`)
    })
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(rendererUrl)
})

app.on('before-quit', () => service.stopAll())
app.on('window-all-closed', () => app.quit())
