import type { LiveCallState, LiveEndReason } from "../../shared/wire";
import type { desktopCapabilitiesNow } from "./desktop";
import { t } from "./i18n";
import type { LiveCallAction } from "./live-call-media-types.ts";

const CAPTION_CHARS = 240;
const HEARD_CHARS = 160;

export const HEARD_CLEAR_MS = 2_500;

type DesktopCapabilities = ReturnType<typeof desktopCapabilitiesNow>;

export function applyCaption(current: { caption: string; heard: string }, event: { type?: unknown; delta?: unknown }): { caption: string; heard: string } {
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (event.type === "session.output_transcript.delta") return { caption: (current.caption + delta).slice(-CAPTION_CHARS), heard: "" };
  if (event.type === "session.input_transcript.delta") return { caption: current.caption, heard: (current.heard + delta).slice(-HEARD_CHARS) };
  return current;
}

export function endNotice(reason: LiveEndReason | undefined): { text: string; dropped: boolean } {
  switch (reason) {
    case "idle": return { text: t("call.live.endedIdle"), dropped: false };
    case "expired": return { text: t("call.live.endedExpired"), dropped: false };
    case "content": return { text: t("call.live.endedContent"), dropped: false };
    case "deleted": return { text: t("call.live.endedDeleted"), dropped: false };
    case "shutdown": return { text: t("call.live.endedShutdown"), dropped: false };
    case "signed-out": return { text: t("call.live.endedSignedOut"), dropped: false };
    case "remote-hangup":
    case "connection-lost":
    case "sideband-lost":
    case "error": return { text: t("call.live.dropped"), dropped: true };
    default: return { text: t("call.live.ended"), dropped: false };
  }
}

export function busyText(call: LiveCallState): string {
  return t(`call.live.busy.${call.client}`);
}

function inWebBrowser(capabilities: DesktopCapabilities): boolean {
  return capabilities.dictation.reasonCode === "desktop-app-required";
}

export function micBlocked(
  capabilities: DesktopCapabilities,
  pageMic: "allowed" | "refused" | undefined,
): { notice: string; action: LiveCallAction } {
  if (pageMic === "refused" || (pageMic === undefined && capabilities.dictation.reasonCode === "remote-server")) {
    return { notice: t("call.live.micAppRefused"), action: "open-in-browser" };
  }
  return { notice: t(inWebBrowser(capabilities) ? "call.live.micBlockedBrowser" : "call.live.micBlocked"), action: "retry" };
}

export function liveClient(capabilities: DesktopCapabilities): "desktop" | "web" {
  return inWebBrowser(capabilities) ? "web" : "desktop";
}
