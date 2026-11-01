import { buildDiagnosticsReport } from "./operationLog"

type ClipboardRuntime = { Platform?: { ClipboardAPI?: { copy?: (text: string) => unknown } } }

const writeToClipboard = async (text: string): Promise<void> => {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (clipboard?.writeText) {
    await clipboard.writeText(text)
    return
  }
  const fallback = (Spicetify as unknown as ClipboardRuntime).Platform?.ClipboardAPI?.copy
  if (!fallback) throw new Error("No clipboard available")
  await fallback(text)
}

/** Copies the diagnostics report and tells the listener whether it worked. */
export const copyDiagnostics = async (): Promise<boolean> => {
  try {
    await writeToClipboard(buildDiagnosticsReport())
    Spicetify.showNotification("Diagnostics copied")
    return true
  } catch {
    Spicetify.showNotification("Could not copy diagnostics", true)
    return false
  }
}
