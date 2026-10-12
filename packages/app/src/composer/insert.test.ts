import { describe, expect, test } from "bun:test"
import { insertText } from "./editor/actions"
import type { ComposerPrompt } from "./types"

describe("composer insert", () => {
  test("appends into an empty composer", () => {
    const prompt: ComposerPrompt = [{ type: "text", content: "", start: 0, end: 0 }]

    expect(insertText(prompt, 0, "hello")).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
  })

  test("keeps what the user already typed", () => {
    const prompt: ComposerPrompt = [{ type: "text", content: "fix the ", start: 0, end: 8 }]

    // Dictation must not clobber a half-typed prompt.
    expect(insertText(prompt, 8, "parser")).toEqual([{ type: "text", content: "fix the parser", start: 0, end: 14 }])
  })

  test("inserts at the caret rather than the end", () => {
    const prompt: ComposerPrompt = [{ type: "text", content: "fix parser", start: 0, end: 10 }]

    expect(insertText(prompt, 4, " the ")).toEqual([{ type: "text", content: "fix  the parser", start: 0, end: 15 }])
  })
})
