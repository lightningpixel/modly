import { create } from 'zustand'

// Thumbnails rendered since the library was listed, by workspace path. A tile
// reads its own key, so a finished render repaints that tile only, without
// re-listing the library.

interface AssetThumbnailState {
  urls: Readonly<Record<string, string>>
  setThumbnailUrl: (workspacePath: string, thumbnailUrl: string) => void
}

export const useAssetThumbnailStore = create<AssetThumbnailState>((set) => ({
  urls: {},
  setThumbnailUrl: (workspacePath, thumbnailUrl) => set((state) => (
    state.urls[workspacePath] === thumbnailUrl ? state : { urls: { ...state.urls, [workspacePath]: thumbnailUrl } }
  )),
}))

/** The freshest thumbnail for a library entry: a render from this session, else the one it was listed with. */
export function useAssetThumbnailUrl(entry: { workspacePath: string, thumbnailUrl?: string }): string | undefined {
  return useAssetThumbnailStore((state) => state.urls[entry.workspacePath]) ?? entry.thumbnailUrl
}
