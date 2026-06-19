import * as esbuild from "esbuild"
import { mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
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
  jsx: "transform",
  jsxFactory: "Spicetify.React.createElement",
  jsxFragment: "Spicetify.React.Fragment",
  logLevel: "info",
  banner: {
    js: "// NAME: Shuffle Similar\n// DESCRIPTION: Play songs similar to your seed, with optional progressive blend into your library\n// VERSION: 1.0.0\n// AUTHORS: Shuffle Similar Contributors\n",
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
