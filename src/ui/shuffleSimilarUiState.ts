import { createSimilarMixStatus } from "./status"

type UiSyncHandler = () => void

let syncHandler: UiSyncHandler | null = null

export const shuffleSimilarStatus = createSimilarMixStatus()

export const registerShuffleSimilarUiSync = (handler: UiSyncHandler) => {
  syncHandler = handler

  return () => {
    if (syncHandler === handler) syncHandler = null
  }
}

export const syncShuffleSimilarFromPlayback = () => {
  syncHandler?.()
}
