import {
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PREVIEW_STREAM_TAB_GONE_CODE,
  isPreviewStreamDialog,
  previewStreamDownloadUrl,
  previewStreamUploadUrl,
  withAccessQuery,
  type PreviewStreamControl,
  type PreviewStreamEvents,
  type PreviewStreamHostSetup,
  type PreviewStreamClient,
  type PreviewStreamInput,
  type PreviewStreamTarget,
} from "./browser-stream-client";

const allowed = (input: PreviewStreamInput, control: PreviewStreamControl): boolean =>
  input.type === "takeControl" || input.type === "resize" || input.type === "frameCap" || input.type === "restart" || input.type === "wake" || control.controller === "you";

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  let cap = { width: target.maxWidth, height: target.maxHeight };
  let size = target.width !== undefined && target.height !== undefined ? { width: target.width, height: target.height } : null;
  const streamUrl = () => {
    const query = new URLSearchParams({
      maxWidth: String(Math.max(1, Math.round(cap.width))),
      maxHeight: String(Math.max(1, Math.round(cap.height))),
    });
    if (size) {
      query.set("width", String(Math.round(size.width)));
      query.set("height", String(Math.round(size.height)));
    }
    if (target.interactive === false) query.set("interactive", "false");
    return withAccessQuery(`${target.access.wsBase}/stream?${query.toString()}`, target.access);
  };
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;

  const connect = () => {
    if (stopped) return;
    const opening = { cap, size };
    const ws = new WebSocket(streamUrl());
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        stale,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
        events.onMessage?.(message as Record<string, unknown>);
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
          ...(stale === true ? { stale: true } : {}),
        };
        const first = control === null;
        control = nextControl;
        // A size or cap the viewer asked for while this socket was opening reaches the server now.
        if (first && canOperate && cap !== opening.cap) ws.send(JSON.stringify({ type: "frameCap", maxWidth: cap.width, maxHeight: cap.height }));
        if (first && canOperate && size && size !== opening.size) ws.send(JSON.stringify({ type: "resize", ...size }));
        events.onControl?.(nextControl);
      } else if (typeof type === "string") {
        events.onMessage?.(message as Record<string, unknown>);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      events.onClose?.(event.code, event.reason);
      if (event.code === PREVIEW_STREAM_TAB_GONE_CODE) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (input.type === "resize") size = { width: input.width, height: input.height };
      else if (input.type === "frameCap") cap = { width: input.maxWidth, height: input.maxHeight };
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (!allowed(input, control)) return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo openmausbot browser setup" };
};

