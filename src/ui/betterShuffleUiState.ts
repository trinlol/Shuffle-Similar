type UiSyncHandler = () => void

let syncHandler: UiSyncHandler | null = null

export const registerBetterShuffleUiSync = (handler: UiSyncHandler) => {
  syncHandler = handler
}

export const syncBetterShuffleFromPlayback = () => {
  syncHandler?.()
}
