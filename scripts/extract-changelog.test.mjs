import { describe, expect, it } from "vitest"
import { extractChangelogSection } from "./extract-changelog.mjs"

const changelog = `# Changelog

All notable changes are documented here.

## [Unreleased]

### Changed

- Pending change

## [2.1.3] - 2026-10-31

### Fixed

- Newest fix

## [2.1.2] - 2026-08-31

### Fixed

- Older fix

## [2.1.1] - 2026-08-16

- Oldest entry
`

describe("extractChangelogSection", () => {
  it("finds the 2.1.3 section without its heading", () => {
    expect(extractChangelogSection(changelog, "2.1.3")).toBe("### Fixed\n\n- Newest fix")
  })

  it("stops before the next version heading", () => {
    expect(extractChangelogSection(changelog, "2.1.3")).not.toContain("Older fix")
  })

  it("works for the last section in the file", () => {
    expect(extractChangelogSection(changelog, "2.1.1")).toBe("- Oldest entry")
  })

  it("returns null for an unknown version", () => {
    expect(extractChangelogSection(changelog, "9.9.9")).toBeNull()
  })

  it("does not treat a version as a pattern", () => {
    expect(extractChangelogSection(changelog, "2.1.")).toBeNull()
  })
})
