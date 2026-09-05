/**
 * Guards the Marketplace release artifact.
 *
 * `shuffle-similar.js` is committed at the repo root because Spicetify
 * Marketplace installs it directly, so it can silently fall behind the sources.
 * Comparing minified bytes across platforms is not reliable, but the banner
 * version is, and a mismatch is the signal that someone released without
 * rebuilding.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const read = (relativePath) => {
  try {
    return readFileSync(join(repoRoot, relativePath), "utf8")
  } catch (error) {
    console.error(`Could not read ${relativePath}: ${error.message}`)
    process.exit(1)
  }
}

const { version: packageVersion } = JSON.parse(read("package.json"))
const bundleVersion = read("shuffle-similar.js")
  .match(/^\/\/ VERSION:\s*(.+)$/m)?.[1]
  ?.trim()

if (!bundleVersion) {
  console.error(
    "shuffle-similar.js has no '// VERSION:' banner line. Run 'npm run build:release' and commit the result."
  )
  process.exit(1)
}

if (bundleVersion !== packageVersion) {
  console.error(
    `shuffle-similar.js is stale: bundle reports ${bundleVersion}, package.json declares ${packageVersion}.\n` +
      "Run 'npm run build:release' and commit the result."
  )
  process.exit(1)
}

console.log(`shuffle-similar.js banner matches package.json (${packageVersion}).`)
