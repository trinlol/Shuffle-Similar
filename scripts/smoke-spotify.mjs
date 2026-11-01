#!/usr/bin/env node
// Live smoke test for Shuffle Similar against a running Spotify.
//
// Start Spotify with `--remote-debugging-port=9222`, play any track, then run
// `npm run smoke`. The script mutes Spotify while it works and restores the
// volume, pause state and Similar Mix toggle afterwards.
//
// Checks:
//   extension loaded                 - the playbar button exists
//   enable builds a mix              - with 15 tracks already queued, the mix
//                                      reaches "on" and owns the queue head
//   no queue rebuild on track change - three skips cause no clear/add calls
//   no unexpected notification       - nothing is shown during the skips

const port = Number(process.env.SMOKE_CDP_PORT ?? 9222)

const pageScript = `(async () => {
  const P = Spicetify.Platform.PlayerAPI
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const provider = (t) => t?.provider ?? t?.contextTrack?.metadata?.provider
  const uriOf = (t) => t?.uri ?? t?.contextTrack?.uri
  const queued = () => (Spicetify.Queue?.nextTracks ?? []).filter((t) => provider(t) === "queue").map(uriOf)
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })

  const button = document.querySelector('[data-testid="shuffle-similar-button"]')
  check("extension loaded", button, button ? "" : "playbar button not found")
  if (!button) return checks

  const capsule = () => document.getElementById("similar-mix-status")?.dataset.state
  const settle = async () => {
    const seen = []
    for (let i = 0; i < 150; i++) {
      await wait(200)
      const state = capsule()
      if (seen.at(-1) !== state) seen.push(state)
      if (i > 2 && !["building", "refreshing", "stopping"].includes(state)) break
    }
    return seen
  }

  const volume = Spicetify.Player.getVolume()
  const wasPlaying = Spicetify.Player.isPlaying()
  const wasOn = button.getAttribute("aria-pressed") === "true"
  const originalClear = P.clearQueue.bind(P)
  const originalAdd = P.addToQueue.bind(P)
  const originalNotify = Spicetify.showNotification
  const calls = []
  const notes = []
  P.clearQueue = async (...args) => { calls.push("clear"); return originalClear(...args) }
  P.addToQueue = async (...args) => { calls.push("add"); return originalAdd(...args) }
  Spicetify.showNotification = (message, ...rest) => { notes.push(String(message)); return originalNotify(message, ...rest) }

  try {
    Spicetify.Player.setVolume(0)
    if (wasOn) { button.click(); await settle() }
    if (!Spicetify.Player.isPlaying()) { Spicetify.Player.play(); await wait(1500) }

    const stale = (Spicetify.Queue?.nextTracks ?? []).map(uriOf).filter((u) => u?.startsWith("spotify:track:")).slice(0, 15)
    await originalAdd(stale.map((uri) => ({ uri })))
    await wait(1200)
    const preQueued = queued().length

    notes.length = 0
    button.click()
    const states = await settle()
    const mix = queued()
    check(
      "enable builds a mix",
      states.at(-1) === "on" && mix.length > 20 && !stale.slice(0, 3).includes(mix[0]),
      "pre-queued=" + preQueued + " states=" + states.join(">") + " queued=" + mix.length + " notes=" + JSON.stringify(notes)
    )
    if (states.at(-1) !== "on") return checks

    calls.length = 0
    notes.length = 0
    const counts = [queued().length]
    for (let skip = 0; skip < 3; skip++) {
      Spicetify.Player.next()
      await wait(6000)
      counts.push(queued().length)
    }
    const shrinksByAtMostOne = counts.slice(1).every((count, i) => counts[i] - count >= 0 && counts[i] - count <= 1)
    check("no queue rebuild on track change", calls.length === 0 && shrinksByAtMostOne, "calls=" + JSON.stringify(calls) + " queued=" + counts.join(">"))
    check("no unexpected notification", notes.length === 0, JSON.stringify(notes))
  } catch (error) {
    check("smoke run completed", false, String(error?.message ?? error))
  } finally {
    P.clearQueue = originalClear
    P.addToQueue = originalAdd
    Spicetify.showNotification = originalNotify
    const nowOn = button.getAttribute("aria-pressed") === "true"
    if (nowOn !== wasOn) { button.click(); await settle() }
    if (!wasPlaying) Spicetify.Player.pause()
    Spicetify.Player.setVolume(volume)
  }
  return checks
})()`

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

let targets
try {
  targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
} catch {
  fail(`could not reach Spotify on port ${port}; start it with --remote-debugging-port=${port}`)
}
const page = targets.find((target) => target.type === "page" && target.url.includes("xpui"))
if (!page) fail("Spotify's xpui page is not open yet")

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve)
  socket.addEventListener("error", reject)
})

const timer = setTimeout(() => fail("timed out after 150 s"), 150_000)
socket.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: pageScript, awaitPromise: true, returnByValue: true },
  })
)

const checks = await new Promise((resolve) => {
  socket.addEventListener("message", (message) => {
    const reply = JSON.parse(message.data)
    if (reply.id !== 1) return
    const value = reply.result?.result?.value
    if (!Array.isArray(value)) {
      fail(
        `page script error: ${JSON.stringify(reply.result?.exceptionDetails ?? reply.error ?? reply)}`
      )
    }
    resolve(value)
  })
})
clearTimeout(timer)
socket.close()

for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`)
}
process.exit(checks.length > 0 && checks.every((entry) => entry.ok) ? 0 : 1)
