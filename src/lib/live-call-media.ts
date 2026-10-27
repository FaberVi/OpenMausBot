// Its data channel may only send session.close; everything else about the call runs on the harness.
import { useSyncExternalStore } from "react";
import type { LiveCallState } from "../../shared/wire";
import { ApiError } from "@/state/store";
import { endCall, startCall } from "./call";
import { t } from "./i18n";
import { createDefaultLiveMediaDeps, LiveUnsupportedError } from "./live-call-media-defaults.ts";
import {
  applyCaption,
  busyText,
  endNotice,
  HEARD_CLEAR_MS,
  liveClient,
  micBlocked,
} from "./live-call-media-caption.ts";
import { iceGathered } from "./live-call-media-ice.ts";
import { handleLiveCallKey as handleLiveCallKeyInner } from "./live-call-media-keys.ts";
import type { LiveMediaDeps, LiveMediaState } from "./live-call-media-types.ts";
import { isLiveCallRunning } from "./live-call-media-types.ts";

export type { LiveCallAction, LiveMediaDeps, LiveMediaPhase, LiveMediaState } from "./live-call-media-types.ts";
export { isLiveCallRunning } from "./live-call-media-types.ts";
export { applyCaption, endNotice } from "./live-call-media-caption.ts";
export { liveCallChord, liveCallShortcut, type LiveCallShortcut } from "./live-call-media-keys.ts";

const IDLE: LiveMediaState = {
  phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false,
  caption: "", heard: "", notice: null, needsKey: false, busyWith: null, action: null, hangingUp: false,
};
const ENDED_NOTICE_MS = 4_000;
const SERVER_CLOSE_GRACE_MS = 3_000;
export const MEDIA_CONNECT_TIMEOUT_MS = 20_000;

let deps: LiveMediaDeps = createDefaultLiveMediaDeps();

let state: LiveMediaState = IDLE;
let generation = 0;
let microphone: MediaStream | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let heardTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let stopGestureWait: (() => void) | null = null;
let serverCall: LiveCallState | null = null;
let serverAttached = false;
const watchers = new Set<() => void>();

function set(patch: Partial<LiveMediaState>) {
  state = { ...state, ...patch };
  for (const watcher of Array.from(watchers)) watcher();
}

export function liveMedia(): LiveMediaState {
  return state;
}

/** One function for every consumer, so useSyncExternalStore never resubscribes on a render. */
export function subscribeLiveMedia(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function useLiveMedia(): LiveMediaState {
  return useSyncExternalStore(subscribeLiveMedia, liveMedia, liveMedia);
}

export function configureLiveMedia(overrides: Partial<LiveMediaDeps>): void {
  deps = { ...createDefaultLiveMediaDeps(), ...overrides };
}

export function resetLiveMedia(): void {
  release();
  generation += 1;
  deps = createDefaultLiveMediaDeps();
  state = IDLE;
  serverCall = null;
  serverAttached = false;
}

export async function startLiveCall(target: { botId: string; threadId: string }): Promise<void> {
  if (isLiveCallRunning(state.phase)) return;
  release();
  const mine = ++generation;
  serverAttached = false;
  set({ ...IDLE, phase: "starting", botId: target.botId, threadId: target.threadId });
  startCall(target.botId);
  try {
    const stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mine !== generation) return void stream.getTracks().forEach((track) => track.stop());
    microphone = stream;
    for (const track of stream.getAudioTracks()) track.enabled = !state.muted;
    const connection = deps.createPeer();
    peer = connection;
    connection.ontrack = (event) => {
      if (mine !== generation) return;
      void Promise.resolve(deps.playRemote(event.track)).catch(() => {
        if (mine !== generation) return;
        set({ notice: t("call.live.clickToHear") });
        playOnGesture(mine, event.track);
      });
    };
    connection.onconnectionstatechange = () => {
      if (mine !== generation) return;
      if (connection.connectionState === "connected") stopConnectWait();
      else if (connection.connectionState === "failed") void dropped(t("call.live.dropped"));
    };
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
    // the event channel must exist before the offer is created
    const events = connection.createDataChannel("oai-events");
    channel = events;
    events.onopen = () => {
      if (mine === generation) goLiveWhenReady();
    };
    events.onmessage = (event) => {
      if (mine === generation) onChannelMessage(event.data);
    };
    await connection.setLocalDescription(await connection.createOffer());
    await iceGathered(connection, deps.iceTimeoutMs);
    if (mine !== generation) return;
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error(t("call.live.noOffer"));
    const result = await deps.request<{ call: LiveCallState; transport: { sdp: string } }>("/api/live/session", {
      method: "POST",
      body: JSON.stringify({ botId: target.botId, threadId: target.threadId, sdp, client: liveClient(deps.capabilities()) }),
      timeoutMs: 35_000,
    });
    if (mine !== generation) {
      void endOnServer(result.call.callId);
      return;
    }
    const seen = serverCall;
    set({ callId: result.call.callId });
    applyServerCall(result.call);
    // The SSE frame can overtake this response; it was ignored then because the id was not known yet.
    if (seen?.callId === result.call.callId) applyServerCall(seen);
    if (mine !== generation) return;
    await connection.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
    if (mine !== generation) return;
    if (connection.connectionState !== "connected") {
      connectTimer = setTimeout(() => {
        if (mine === generation) void dropped(t("call.live.droppedNoAudio"));
      }, MEDIA_CONNECT_TIMEOUT_MS);
    }
  } catch (error) {
    if (mine !== generation) return;
    const body = error instanceof ApiError ? (error.body as { needsKey?: boolean; activeCall?: LiveCallState } | undefined) : undefined;
    if (state.callId) void endOnServer(state.callId);
    release();
    if (body?.needsKey) return set({ ...IDLE, needsKey: true, botId: target.botId, threadId: target.threadId });
    if (body?.activeCall) return set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, busyWith: body.activeCall, notice: busyText(body.activeCall) });
    const failed = { ...IDLE, phase: "failed" as const, botId: target.botId, threadId: target.threadId };
    if (error instanceof DOMException && error.name === "NotFoundError") return set({ ...failed, notice: t("call.live.micMissing"), action: "retry" });
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      const pageMic = await deps.pageMicrophone();
      if (mine !== generation) return;
      return set({ ...failed, ...micBlocked(deps.capabilities(), pageMic) });
    }
    const hopeless = error instanceof LiveUnsupportedError || (error instanceof ApiError && error.status === 401);
    set({ ...failed, action: hopeless ? null : "retry", notice: error instanceof Error ? error.message : String(error) });
  }
}

export async function hangUpLiveCall(): Promise<void> {
  const { callId, phase } = state;
  if (phase === "idle" || phase === "ended" || phase === "failed") return dismissLiveNotice();
  const mine = ++generation;
  set({ phase: "ending", hangingUp: true });
  // Stop capturing now; keep the channel alive until its close command and the end request leave.
  stopCapturing();
  sendClose();
  if (callId) await endOnServer(callId);
  if (mine !== generation) return;
  release();
  set({ ...IDLE });
}

export function setLiveMuted(muted: boolean): void {
  for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  set({ muted });
}

export function handleLiveCallKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "defaultPrevented">, isMac: boolean): boolean {
  return handleLiveCallKeyInner(event, isMac, {
    phase: state.phase,
    muted: state.muted,
    onMute: setLiveMuted,
    onHangUp: () => { void hangUpLiveCall(); },
  }, isLiveCallRunning);
}

export function dismissStartPrompt(botId: string): void {
  if (state.needsKey && state.botId === botId) dismissLiveNotice();
}

export function takeLiveCallAction(): void {
  const { action, botId, threadId, phase } = state;
  if (phase !== "failed") return;
  if (action === "retry" && botId && threadId) void startLiveCall({ botId, threadId });
  else if (action === "open-in-browser" && globalThis.location?.href) deps.openInBrowser(globalThis.location.href);
}

export function dismissLiveNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  if (state.phase === "ended" || state.phase === "failed" || state.needsKey) set({ ...IDLE });
}

export function endSignedOut(): void {
  if (!isLiveCallRunning(state.phase)) return;
  finish(endNotice("signed-out"));
}

export async function checkLiveSignIn(): Promise<void> {
  if (!isLiveCallRunning(state.phase)) return;
  const mine = generation;
  try {
    await deps.request("/api/live/call", { timeoutMs: 8_000 });
  } catch (error) {
    if (mine === generation && error instanceof ApiError && error.status === 401) endSignedOut();
  }
}

export function onLiveStreamConnected(connected: boolean): void {
  if (!connected) void checkLiveSignIn();
}

export function onServerCall(call: LiveCallState | null): void {
  serverCall = call;
  applyServerCall(call);
}

function applyServerCall(call: LiveCallState | null) {
  if (!state.callId) return;
  if (!call) {
    if (state.phase === "starting" || state.phase === "live") finish({ text: t("call.live.ended"), dropped: false });
    return;
  }
  if (call.callId !== state.callId) return;
  if (call.status === "ended") {
    if (call.endReason === "hung-up" && state.hangingUp) endQuietly();
    else finish(endNotice(call.endReason), call.error);
    return;
  }
  if (call.status !== "connecting") serverAttached = true;
  if (call.status === "ending") {
    stopCapturing();
    stopConnectWait();
    if (state.phase !== "ending") set({ phase: "ending" });
    return;
  }
  goLiveWhenReady();
}

function goLiveWhenReady() {
  if (state.phase !== "starting" || !serverAttached || channel?.readyState !== "open") return;
  set({ phase: "live", startedAt: Date.now() });
}

function endQuietly() {
  release();
  generation += 1;
  set({ ...IDLE });
}

function finish(notice: { text: string; dropped: boolean }, detail?: string) {
  sendClose();
  release();
  generation += 1;
  const { botId, threadId } = state;
  set({
    ...IDLE, phase: notice.dropped ? "failed" : "ended", botId, threadId,
    notice: detail?.trim() || notice.text, action: notice.dropped ? "retry" : null,
  });
  if (!notice.dropped) {
    noticeTimer = setTimeout(dismissLiveNotice, ENDED_NOTICE_MS);
  }
}

async function dropped(text: string) {
  const { callId } = state;
  finish({ text, dropped: true });
  if (callId) await endOnServer(callId);
}

async function endOnServer(callId: string): Promise<void> {
  await deps.request("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId }), timeoutMs: 8_000 }).catch(() => undefined);
}

function onChannelMessage(raw: unknown) {
  let event: { type?: unknown; delta?: unknown };
  try {
    event = JSON.parse(String(raw)) as { type?: unknown; delta?: unknown };
  } catch {
    return;
  }
  if (event.type === "session.closed") {
    stopCapturing();
    stopConnectWait();
    if (!closeTimer) void checkLiveSignIn();
    closeTimer ??= setTimeout(() => finish({ text: t("call.live.ended"), dropped: false }), SERVER_CLOSE_GRACE_MS);
    return;
  }
  const next = applyCaption(state, event);
  if (next.caption === state.caption && next.heard === state.heard) return;
  set(next);
  if (event.type === "session.input_transcript.delta") {
    if (heardTimer) clearTimeout(heardTimer);
    heardTimer = setTimeout(() => set({ heard: "" }), HEARD_CLEAR_MS);
  }
}

/** Autoplay was blocked: the next click or key press plays the audio (a user gesture allows play()). */
function playOnGesture(mine: number, track: MediaStreamTrack) {
  const target = globalThis.document;
  if (!target || stopGestureWait) return;
  const retry = () => {
    stopGestureWait?.();
    stopGestureWait = null;
    if (mine !== generation) return;
    void Promise.resolve(deps.playRemote(track)).then(
      () => {
        if (mine === generation && state.notice === t("call.live.clickToHear")) set({ notice: null });
      },
      () => {
        if (mine === generation) playOnGesture(mine, track);
      },
    );
  };
  target.addEventListener("pointerdown", retry, true);
  target.addEventListener("keydown", retry, true);
  stopGestureWait = () => {
    target.removeEventListener("pointerdown", retry, true);
    target.removeEventListener("keydown", retry, true);
  };
}

function stopConnectWait() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

function sendClose() {
  if (channel?.readyState === "open") {
    try { channel.send(JSON.stringify({ type: "session.close" })); } catch {}
  }
}

function stopCapturing() {
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
}

function release() {
  for (const timer of [heardTimer, closeTimer, noticeTimer, connectTimer]) if (timer) clearTimeout(timer);
  heardTimer = closeTimer = noticeTimer = connectTimer = null;
  stopGestureWait?.();
  stopGestureWait = null;
  stopCapturing();
  try { channel?.close(); } catch {}
  channel = null;
  try { peer?.close(); } catch {}
  peer = null;
  deps.stopRemote();
  if (state.botId) endCall(state.botId);
}

