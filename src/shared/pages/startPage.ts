// The page the app opens on. Kept in localStorage by this module rather than in
// appStore, so navStore can read it at init and still load under `node --test`.

export type StartPage = 'home' | 'generate'

export const START_PAGES: readonly StartPage[] = ['home', 'generate']
export const DEFAULT_START_PAGE: StartPage = 'home'

const STORAGE_KEY = 'modly.startPage'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

function defaultStorage(): Storage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

export function readStartPage(storage: Storage | undefined = defaultStorage()): StartPage {
  try {
    const value = storage?.getItem(STORAGE_KEY)
    return (START_PAGES as readonly string[]).includes(value ?? '') ? value as StartPage : DEFAULT_START_PAGE
  } catch {
    return DEFAULT_START_PAGE
  }
}

export function writeStartPage(page: StartPage, storage: Storage | undefined = defaultStorage()): void {
  try { storage?.setItem(STORAGE_KEY, page) } catch { /* private mode / quota */ }
}
