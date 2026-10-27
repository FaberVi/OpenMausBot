import type { LiveCallState } from "../../shared/wire";
import type { desktopCapabilitiesNow } from "./desktop";

export type LiveMediaPhase = "idle" | "starting" | "live" | "ending" | "ended" | "failed";

export type LiveCallAction = "retry" | "open-in-browser";

export function isLiveCallRunning(phase: LiveMediaPhase): boolean {
  return phase === "starting" || phase === "live" || phase === "ending";
}

export interface LiveMediaState {
  phase: LiveMediaPhase;
  callId: string | null;
  botId: string | null;
  threadId: string | null;
  startedAt: number | null;
  muted: boolean;
  caption: string;
  heard: string;
  notice: string | null;
  needsKey: boolean;
  busyWith: LiveCallState | null;
  action: LiveCallAction | null;
  hangingUp: boolean;
}

export interface LiveMediaDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  playRemote(track: MediaStreamTrack): Promise<void> | void;
  stopRemote(): void;
  iceTimeoutMs: number;
  capabilities(): ReturnType<typeof desktopCapabilitiesNow>;
  pageMicrophone(): Promise<"allowed" | "refused" | undefined>;
  openInBrowser(url: string): void;
}
