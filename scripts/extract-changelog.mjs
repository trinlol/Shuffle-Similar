#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, without its heading.
// Usage: node scripts/extract-changelog.mjs 2.2.0
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HEADING = /^## \[([^\]]+)\]/

/** Text under `## [version]` up to the next `## [` heading, trimmed; null if absent. */
export const extractChangelogSection = (changelog, version) => {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => HEADING.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim()
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isCli) {
  const version = process.argv[2]
  if (!version) {
    console.error("usage: node scripts/extract-changelog.mjs <version>")
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const section = extractChangelogSection(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version)
  if (!section) {
    console.error(`No CHANGELOG.md section for ${version}`)
    process.exit(1)
  }
  console.log(section)
}
