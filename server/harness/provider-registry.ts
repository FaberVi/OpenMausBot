import { findCliCandidates } from "../env-path.ts";
import { serverInstallFor } from "../engine-install.ts";
import type { AnyProviderDriver, ProviderSnapshot } from "../contracts.ts";

export function withServerInstall(install: AnyProviderDriver["install"], npmPresent: boolean): AnyProviderDriver["install"] {
  if (!install) return undefined;
  const server = serverInstallFor(install, npmPresent);
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : undefined;
  return { ...install, platform, ...(server ? { server } : {}) };
}

export function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

export function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

export const SNAPSHOT_DEADLINE_MS = 60_000;
/** How long a finished status read answers later reads, so a start-up's model lists and engine-list reads probe each CLI once. */
export const SNAPSHOT_REUSE_MS = 3_000;
const SNAPSHOT_DEADLINE_REASON = "This engine did not report its status within a minute. Check that its CLI starts in a terminal.";

export function withinDeadline(read: () => Promise<ProviderSnapshot>): Promise<ProviderSnapshot> {
  let deadline: NodeJS.Timeout | undefined;
  return Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(SNAPSHOT_DEADLINE_REASON)), SNAPSHOT_DEADLINE_MS);
      deadline.unref?.();
    }),
  ]).finally(() => clearTimeout(deadline));
}

/** How long the start-up read waits on one CLI before probing the next, so a stuck CLI holds back no other for long. */
export const START_READ_STEP_MS = 5_000;

export function settledOrAfter(read: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([read, new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

export function cliCandidatesFor(
  driver: AnyProviderDriver | undefined,
  cache: Map<string, string[]>,
): string[] {
  const name = cliDefaultOf(driver);
  if (!name) return [];
  const cached = cache.get(name);
  if (cached) return cached;
  const found = findCliCandidates(name);
  cache.set(name, found);
  return found;
}
