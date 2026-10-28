import { t } from "@/lib/i18n";
import { replaceNeedsInputLabel } from "../../shared/needs-input-display";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard";

export function displayBotMessageText(raw: string): string {
  return replaceNeedsInputLabel(stripLeakedSystemHarnessMessages(raw), t("chat.needsInput.label"));
}
