type UiSyncHandler = () => void

let syncHandler: UiSyncHandler | null = null

export const registerShuffleSimilarUiSync = (handler: UiSyncHandler) => {
  syncHandler = handler
}

export const syncShuffleSimilarFromPlayback = () => {
  syncHandler?.()
}
