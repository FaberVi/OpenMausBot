import type { LiveMediaPhase } from "./live-call-media-types.ts";

export type LiveCallShortcut = "mute" | "hangUp";

type ChordEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "defaultPrevented">;

export function liveCallShortcut(event: ChordEvent, isMac: boolean): LiveCallShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey) return null;
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  return key === "m" ? "mute" : key === "h" ? "hangUp" : null;
}

export function liveCallChord(action: LiveCallShortcut, isMac: boolean): { text: string; aria: string } {
  const letter = action === "mute" ? "M" : "H";
  return isMac ? { text: `⌘⇧${letter}`, aria: `Meta+Shift+${letter}` } : { text: `Ctrl+Shift+${letter}`, aria: `Control+Shift+${letter}` };
}

export type LiveCallKeyHandler = {
  phase: LiveMediaPhase;
  muted: boolean;
  onMute(muted: boolean): void;
  onHangUp(): void;
};

export function handleLiveCallKey(event: ChordEvent, isMac: boolean, live: LiveCallKeyHandler, isRunning: (phase: LiveMediaPhase) => boolean): boolean {
  const action = liveCallShortcut(event, isMac);
  if (!action || !isRunning(live.phase)) return false;
  if (action === "mute") live.onMute(!live.muted);
  else live.onHangUp();
  return true;
}
