import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const cssPath = process.argv[2]
if (!cssPath) throw new Error("Usage: node scripts/benchmark-afterglow.mjs <user.css>")
const themeJsPath = process.argv[3]

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const css = await readFile(path.resolve(cssPath), "utf8")
const themeJs = themeJsPath ? await readFile(path.resolve(themeJsPath), "utf8") : ""

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const waitForDebugTarget = async (port) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
        response.json()
      )
      const page = targets.find((target) => target.type === "page")
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // Edge is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error("Timed out waiting for the Edge debugging target")
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    })
  }

  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true })
      this.socket.addEventListener("error", reject, { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

const _htmlEscape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const artwork =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#e5a14a"/><stop offset=".48" stop-color="#6e2e1a"/><stop offset="1" stop-color="#182c26"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="160" cy="160" r="130" fill="#f2d6a2" fill-opacity=".5"/></svg>'
  )

const cards = Array.from(
  { length: 60 },
  (_, index) => `
  <article class="main-card-card">
    <div class="main-cardImage-imageWrapper" style="background:hsl(${(index * 31) % 360} 42% 38%)"></div>
    <h2>Daily station ${index + 1}</h2><p>Album and artist details</p>
  </article>`
).join("")

const rows = Array.from(
  { length: 360 },
  (_, index) => `
  <div class="main-trackList-trackListRow" aria-selected="${index === 3}">
    <span>${index + 1}</span><a class="main-trackList-rowTitle">Track ${index + 1}</a>
    <span class="main-trackList-rowSubTitle">Artist ${index % 24}</span><time>${3 + (index % 3)}:${String(index % 60).padStart(2, "0")}</time>
  </div>`
).join("")

const documentHtml = `<!doctype html><html style="--afterglow-artwork:url('${artwork}')"><head>
<meta charset="utf-8"><style>
${css}
*{box-sizing:border-box} html,body{margin:0;width:100%;height:100%;overflow:hidden}
.Root__top-container{display:grid;grid-template-columns:230px minmax(0,1fr) 280px;grid-template-rows:minmax(0,1fr) 104px;width:100vw;height:100vh}
.Root__nav-bar{grid-column:1;grid-row:1;padding:20px}.Root__main-view{grid-column:2;grid-row:1}.Root__right-sidebar{grid-column:3;grid-row:1;padding:20px}.Root__now-playing-bar{grid-column:1/4;grid-row:2;display:flex;align-items:center;padding:14px 20px}
.main-view-container__scroll-node{height:100%;overflow:auto}.main-view-container__scroll-node-child{padding:0 28px 80px}
.main-topBar-background{position:sticky;z-index:4;top:0;height:56px;margin:0 -28px;padding:18px 28px}.main-entityHeader-title{font-size:64px;margin:34px 0 20px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:18px}.main-card-card{padding:10px;min-width:0}.main-card-card h2{font-size:14px}.main-card-card p{color:#a99f92;font-size:12px}.main-cardImage-imageWrapper{width:100%;aspect-ratio:1}
.main-trackList-trackListHeader{position:sticky;z-index:3;top:56px;padding:14px 12px}.main-trackList-trackListRow{display:grid;grid-template-columns:36px 1.5fr 1fr 54px;gap:12px;align-items:center;min-height:42px;padding:0 12px}.main-trackList-trackListRow a{color:#f7f1e8}.main-trackList-trackListRow span,.main-trackList-trackListRow time{color:#a99f92;font-size:12px}
.library-item,.queue-item{height:42px;border-bottom:1px solid rgba(255,255,255,.05);padding:12px 0}.main-nowPlayingWidget-coverArt{background:#6e2e1a;width:62px;height:62px;margin-right:14px}
</style><script>
window.__afterglowQueryCount = 0;
const nativeDocumentQuerySelector = Document.prototype.querySelector;
const nativeElementQuerySelector = Element.prototype.querySelector;
Document.prototype.querySelector = function (...args) { window.__afterglowQueryCount += 1; return nativeDocumentQuerySelector.apply(this, args); };
Element.prototype.querySelector = function (...args) { window.__afterglowQueryCount += 1; return nativeElementQuerySelector.apply(this, args); };
window.Spicetify = { Player: { addEventListener() {}, removeEventListener() {} } };
</script></head><body><div class="Root__top-container">
<aside class="Root__nav-bar"><h2>Your Library</h2>${Array.from({ length: 11 }, (_, i) => `<div class="library-item">Playlist ${i + 1}</div>`).join("")}</aside>
<main class="Root__main-view"><div class="main-view-container__scroll-node"><div class="main-view-container__scroll-node-child">
<div class="main-topBar-background">Home&nbsp;&nbsp;&nbsp; Music&nbsp;&nbsp;&nbsp; Podcasts</div><h1 class="main-entityHeader-title">Afterglow Radio</h1><section class="cards">${cards}</section>
<div class="main-trackList-trackListHeader"># &nbsp;&nbsp; Title</div>${rows}</div></div></main>
<aside class="Root__right-sidebar"><h2>Queue</h2>${Array.from({ length: 11 }, (_, i) => `<div class="queue-item">Next track ${i + 1}</div>`).join("")}</aside>
<footer class="Root__now-playing-bar"><div class="main-nowPlayingWidget-coverArt"><img src="${artwork}" alt=""></div><div><strong>Freshly brewed</strong><br><small>Afterglow</small></div></footer>
</div>${themeJs ? `<script>${themeJs.replaceAll("</script>", "<\\/script>")}</script>` : ""}</body></html>`

const getMetrics = async (client) => {
  const result = await client.send("Performance.getMetrics")
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]))
}

const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]
}

const port = await getFreePort()
const profileDir = await mkdtemp(path.join(os.tmpdir(), "afterglow-bench-"))
const edge = spawn(
  edgePath,
  [
    "--headless=new",
    "--disable-gpu-vsync",
    "--disable-background-networking",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,720",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true }
)

let client
try {
  const targetUrl = await waitForDebugTarget(port)
  client = new CdpClient(targetUrl)
  await client.connect()
  await client.send("Page.enable")
  await client.send("Performance.enable")
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const { frameTree } = await client.send("Page.getFrameTree")
  await client.send("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: documentHtml,
  })
  await new Promise((resolve) => setTimeout(resolve, 900))

  for (let index = 0; index < 3; index += 1) {
    await client.send("Page.captureScreenshot", { format: "png", fromSurface: true })
  }

  const runs = []
  for (let run = 0; run < 7; run += 1) {
    const before = await getMetrics(client)
    const startedAt = performance.now()
    for (let step = 0; step < 12; step += 1) {
      const ratio = step % 2 === 0 ? step / 12 : 1 - step / 12
      await client.send("Runtime.evaluate", {
        expression: `new Promise(resolve => { const el=document.querySelector('.main-view-container__scroll-node'); el.scrollTop=(el.scrollHeight-el.clientHeight)*${ratio}; requestAnimationFrame(() => requestAnimationFrame(resolve)); })`,
        awaitPromise: true,
      })
      await client.send("Page.captureScreenshot", { format: "png", fromSurface: true })
    }
    const elapsedMs = performance.now() - startedAt
    const after = await getMetrics(client)
    runs.push({
      elapsedMs,
      taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      heapDeltaKb: (after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024,
    })
  }

  const observerRuns = []
  if (themeJs) {
    for (let run = 0; run < 7; run += 1) {
      const before = await getMetrics(client)
      const result = await client.send("Runtime.evaluate", {
        expression: `(async () => {
          const host = document.createElement('div');
          document.body.append(host);
          window.__afterglowQueryCount = 0;
          const startedAt = performance.now();
          for (let batch = 0; batch < 1000; batch += 1) {
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < 10; index += 1) {
              const item = document.createElement('div');
              item.innerHTML = '<span><i></i></span>';
              fragment.append(item);
            }
            host.replaceChildren(fragment);
            await Promise.resolve();
          }
          const elapsedMs = performance.now() - startedAt;
          const queryCount = window.__afterglowQueryCount;
          host.remove();
          await Promise.resolve();
          return { elapsedMs, queryCount };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      const after = await getMetrics(client)
      observerRuns.push({
        elapsedMs: result.result.value.elapsedMs,
        queryCount: result.result.value.queryCount,
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        heapDeltaKb: (after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024,
      })
    }
  }

  const values = (key) => runs.map((run) => run[key])
  const summary = {
    css: path.resolve(cssPath),
    scenario: "1280x720 Spotify mock, 60 cards, 360 rows, 12 scroll-and-capture frames",
    iterations: runs.length,
    metrics: Object.fromEntries(
      ["elapsedMs", "taskMs", "layoutMs", "styleMs", "scriptMs", "heapDeltaKb"].map((key) => [
        key,
        {
          p50: percentile(values(key), 0.5),
          p95: percentile(values(key), 0.95),
          min: Math.min(...values(key)),
          max: Math.max(...values(key)),
        },
      ])
    ),
    runs,
    observerStress: observerRuns.length
      ? {
          scenario: "1000 unrelated DOM replacement batches of 10 nodes",
          metrics: Object.fromEntries(
            ["elapsedMs", "queryCount", "taskMs", "scriptMs", "heapDeltaKb"].map((key) => [
              key,
              {
                p50: percentile(
                  observerRuns.map((run) => run[key]),
                  0.5
                ),
                p95: percentile(
                  observerRuns.map((run) => run[key]),
                  0.95
                ),
                min: Math.min(...observerRuns.map((run) => run[key])),
                max: Math.max(...observerRuns.map((run) => run[key])),
              },
            ])
          ),
          runs: observerRuns,
        }
      : null,
  }
  console.log(JSON.stringify(summary, null, 2))
} finally {
  client?.close()
  if (!edge.killed) edge.kill()
  await Promise.race([
    new Promise((resolve) => edge.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
