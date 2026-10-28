import { describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { displayBotMessageText } from "./bot-message-text";

describe("displayBotMessageText", () => {
  it("localizes the NEEDS INPUT marker in Italian", () => {
    setLocale("it");
    expect(displayBotMessageText("Done.\nNEEDS INPUT: Quale repo?")).toContain("INPUT NECESSARIO: Quale repo?");
    expect(displayBotMessageText("Done.\nNEEDS INPUT: Quale repo?")).not.toContain("NEEDS INPUT:");
  });
});
