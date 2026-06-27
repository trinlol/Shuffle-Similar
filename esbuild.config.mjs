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
const outfile = join(outDir, "better-shuffle.js")

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
    js: "// NAME: Better Shuffle\n// DESCRIPTION: Progressive shuffle — similar genre/era first, then your library\n// VERSION: 1.5.0\n// AUTHORS: Better Shuffle Contributors\n",
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
