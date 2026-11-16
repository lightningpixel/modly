import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

import { createElectronApi } from './electron-api'

// Expose a typed API to the renderer process via window.electron
contextBridge.exposeInMainWorld('electron', createElectronApi(ipcRenderer, webFrame, webUtils))
