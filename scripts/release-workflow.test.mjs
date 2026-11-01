import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")

describe("release workflow", () => {
  it("does not leave the write-scoped token in .git/config for install and test scripts", () => {
    const checkout = workflow.match(/- uses: actions\/checkout@[^\n]+\n((?: {8,}[^\n]*\n)*)/)
    expect(checkout).not.toBeNull()
    expect(checkout?.[1] ?? "").toMatch(/persist-credentials:\s*false/)
  })
})
