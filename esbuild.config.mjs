import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"))
const isWatch = process.argv.includes("--watch")
const isLocal = process.argv.includes("--local")
const isRelease = process.argv.includes("--release")

const outDir = isRelease
  ? __dirname
  : isLocal
    ? join(__dirname, "dist")
    : join(process.env.APPDATA || "", "spicetify", "Extensions")
const outfile = join(outDir, "shuffle-similar.js")

const buildOptions = {
  entryPoints: [join(__dirname, "src", "app.tsx")],
  bundle: true,
  outfile,
  format: "iife",
  target: "es2020",
  minify: !isWatch,
  jsx: "transform",
  jsxFactory: "Spicetify.React.createElement",
  jsxFragment: "Spicetify.React.Fragment",
  logLevel: "info",
  banner: {
    js: [
      "// NAME: Shuffle Similar",
      "// DESCRIPTION: Adaptive, source-resilient Similar Mix queues with private automatic learning",
      `// VERSION: ${version}`,
      "// AUTHORS: Shuffle Similar Contributors",
      "",
    ].join("\n"),
  },
}

const run = async () => {
  mkdirSync(outDir, { recursive: true })

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log(`Watching → ${outfile}`)
    return
  }

  await esbuild.build(buildOptions)
  console.log(`Built → ${outfile}`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
