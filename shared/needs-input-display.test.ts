import { describe, expect, it } from "vitest";

import { replaceNeedsInputLabel } from "./needs-input-display.ts";

describe("replaceNeedsInputLabel", () => {
  it("localizes a line-start NEEDS INPUT marker and leaves the question", () => {
    const raw = "Half done.\nNEEDS INPUT: Which repository?";
    expect(replaceNeedsInputLabel(raw, "INPUT NECESSARIO:")).toBe("Half done.\nINPUT NECESSARIO: Which repository?");
  });

  it("does not change a mention mid-sentence", () => {
    const raw = "All done. NEEDS INPUT: not at line start";
    expect(replaceNeedsInputLabel(raw, "INPUT NECESSARIO:")).toBe(raw);
  });

  it("matches case-insensitively at line start", () => {
    expect(replaceNeedsInputLabel("needs input: staging?", "X:")).toBe("X: staging?");
  });
});
