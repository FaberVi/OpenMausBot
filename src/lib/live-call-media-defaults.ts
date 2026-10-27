import { api } from "@/state/store";
import { openExternalLink } from "./app-links";
import { desktopCapabilitiesNow } from "./desktop";
import { t } from "./i18n";
import type { LiveMediaDeps } from "./live-call-media-types.ts";

export class LiveUnsupportedError extends Error {}

let audio: HTMLAudioElement | null = null;

export function createDefaultLiveMediaDeps(): LiveMediaDeps {
  return {
    getUserMedia: (constraints) => {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia) return Promise.reject(new LiveUnsupportedError(t("call.live.unsupported")));
      return navigator.mediaDevices.getUserMedia(constraints);
    },
    createPeer: () => {
      if (typeof RTCPeerConnection === "undefined") throw new LiveUnsupportedError(t("call.live.unsupported"));
      return new RTCPeerConnection();
    },
    request: (path, init) => api(path, init),
    playRemote: async (track) => {
      audio ??= Object.assign(document.createElement("audio"), { autoplay: true });
      audio.srcObject = new MediaStream([track]);
      await audio.play();
    },
    stopRemote: () => {
      if (audio) audio.srcObject = null;
    },
    iceTimeoutMs: 10_000,
    capabilities: desktopCapabilitiesNow,
    pageMicrophone: async () => {
      try {
        return (await globalThis.window?.ogb?.permStatus?.())?.pageMic;
      } catch {
        return undefined;
      }
    },
    openInBrowser: (url) => void openExternalLink(url).catch(() => undefined),
  };
}
