import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { BoatCreateRequest } from "./boat-create-idempotency.ts";

const FILE = join(DATA_DIR, "box-create-requests.json");
const LOCK_FILE = join(DATA_DIR, "box-create-requests.lock");
const MAX_REQUESTS = 4_096;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const MAX_REAPER_GENERATIONS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOAT_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

interface JournalLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface JournalReaperOwner extends JournalLockOwner {
  targetToken: string;
}

interface LegacyJournalReaperOwner {
  legacy: true;
  pid: number;
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function isRequest(value: unknown): value is BoatCreateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.botId === "string"
    && BOT_ID.test(request.botId)
    && typeof request.requestBody === "string"
    && request.requestBody.length > 0
    && request.requestBody.length <= 1_024
    && typeof request.idempotencyKey === "string"
    && UUID.test(request.idempotencyKey)
    && typeof request.createdAt === "number"
    && Number.isFinite(request.createdAt)
    && request.createdAt > 0
    && (request.boxId === undefined || (typeof request.boxId === "string" && BOAT_ID.test(request.boxId)))
    && (request.resolved === undefined || (request.resolved === true && typeof request.boxId === "string"))
  );
}

export function recoveryStateError(detail: string, cause?: unknown): Error & { status: number } {
  return Object.assign(
    new Error(
      `Cloud computer creation is paused because its recovery state is ${detail}. `
      + "Check boat.dev for an unnamed Boat before repairing OpenMausBot's local state.",
    ),
    { status: 503, cause },
  );
}

function loadFresh(): BoatCreateRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw recoveryStateError("unreadable", error);
  }
  const file = raw as { version?: unknown; requests?: unknown };
  if (
    !file
    || typeof file !== "object"
    || Array.isArray(file)
    || file.version !== 1
    || !Array.isArray(file.requests)
    || file.requests.length > MAX_REQUESTS
    || !file.requests.every(isRequest)
  ) {
    throw recoveryStateError("invalid");
  }
  const identities = new Set<string>();
  const keys = new Set<string>();
  const botsWithKnownBoats = new Set<string>();
  for (const request of file.requests) {
    const identity = `${request.botId}\0${request.requestBody}`;
    if (identities.has(identity) || keys.has(request.idempotencyKey)) throw recoveryStateError("invalid");
    if (request.boxId && botsWithKnownBoats.has(request.botId)) throw recoveryStateError("invalid");
    identities.add(identity);
    keys.add(request.idempotencyKey);
    if (request.boxId) botsWithKnownBoats.add(request.botId);
  }
  return file.requests.map((request) => ({ ...request }));
}

export function save(next: BoatCreateRequest[]): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    writeFileAtomic(FILE, `${JSON.stringify({ version: 1, requests: next }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw recoveryStateError("unavailable", error);
  }
}

function isLockOwner(value: unknown): value is JournalLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && Number.isInteger(owner.pid)
    && Number(owner.pid) > 0
    && Number(owner.pid) <= 0x7fffffff
    && typeof owner.token === "string"
    && UUID.test(owner.token)
    && typeof owner.createdAt === "number"
    && Number.isFinite(owner.createdAt)
    && owner.createdAt > 0;
}

function readLockOwner(): JournalLockOwner | null {
  let raw: string;
  try {
    raw = readFileSync(LOCK_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw recoveryStateError("lock is unreadable", error);
  }
  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw recoveryStateError("lock is invalid", error);
  }
  if (!isLockOwner(owner)) throw recoveryStateError("lock is invalid");
  return owner;
}

function readReaperOwner(
  path: string,
  targetToken: string,
): JournalReaperOwner | LegacyJournalReaperOwner | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw recoveryStateError("stale-lock recovery record is unreadable", error);
  }

  if (/^[1-9][0-9]*\n?$/.test(raw)) {
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid <= 0x7fffffff) return { legacy: true, pid };
  }

  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw recoveryStateError("stale-lock recovery record is invalid", error);
  }
  if (!isLockOwner(owner) || !("targetToken" in owner) || owner.targetToken !== targetToken) {
    throw recoveryStateError("stale-lock recovery record is invalid");
  }
  return owner as JournalReaperOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    // EPERM proves a process owns the pid even though this account cannot
    // signal it. Every other answer is ambiguous and must keep the lock.
    if (code === "EPERM") return true;
    throw recoveryStateError("lock owner could not be verified", error);
  }
}

function unlinkCandidate(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw recoveryStateError("lock cleanup failed", error);
    }
  }
}

function publishReaper(path: string, owner: JournalReaperOwner): boolean {
  const candidate = `${path}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw recoveryStateError("stale-lock recovery candidate is unavailable", error);
  }
  try {
    try {
      linkSync(candidate, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw recoveryStateError("stale-lock recovery is unavailable", error);
    }
  } finally {
    unlinkCandidate(candidate);
  }
}

function successorReaperPath(targetToken: string, reaperIdentity: string): string {
  const digest = createHash("sha256").update(reaperIdentity).digest("hex").slice(0, 32);
  return `${LOCK_FILE}.reap-${targetToken}-${digest}`;
}

/** Each dead reaper names the next election, and election records are never removed, so no contender can delete a successor's authority. */
function claimReaperAuthority(expected: JournalLockOwner): boolean {
  let reaperPath = `${LOCK_FILE}.reap-${expected.token}`;
  for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation += 1) {
    const candidate: JournalReaperOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
      targetToken: expected.token,
    };
    if (publishReaper(reaperPath, candidate)) return true;

    const current = readReaperOwner(reaperPath, expected.token);
    if (!current) continue;
    if (processIsAlive(current.pid)) return false;
    const identity = "legacy" in current ? `legacy:${current.pid}` : current.token;
    reaperPath = successorReaperPath(expected.token, identity);
  }
  throw recoveryStateError("stale lock could not be recovered after repeated interrupted attempts");
}

function reapDeadLock(expected: JournalLockOwner): boolean {
  if (!claimReaperAuthority(expected)) return false;
  const current = readLockOwner();
  if (!current || current.token !== expected.token) return true;
  if (processIsAlive(current.pid)) return false;
  try {
    unlinkSync(LOCK_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw recoveryStateError("stale lock could not be retired", error);
    }
  }
  return true;
}

function acquireJournalLock(): JournalLockOwner {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw recoveryStateError("lock directory is unavailable", error);
  }
  const owner: JournalLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  // Fully written before link(2) publishes it, so a crash never leaves an ownerless lock (unlike open-then-write).
  const candidate = `${LOCK_FILE}.candidate-${owner.pid}-${owner.token}`;
  try {
    writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600, flush: true });
  } catch (error) {
    throw recoveryStateError("lock candidate is unavailable", error);
  }

  const deadline = performance.now() + LOCK_WAIT_MS;
  try {
    for (;;) {
      try {
        linkSync(candidate, LOCK_FILE);
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
          throw recoveryStateError("lock could not be acquired", error);
        }
      }

      const current = readLockOwner();
      const reaped = current !== null && !processIsAlive(current.pid) && reapDeadLock(current);
      // Every retry path is bounded: an adversarially changing lock can vanish or be replaced between steps.
      if (performance.now() >= deadline) {
        throw recoveryStateError("locked by another OpenMausBot process");
      }
      if (reaped) continue;
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
    }
  } finally {
    unlinkCandidate(candidate);
  }
}

function releaseJournalLock(owner: JournalLockOwner): void {
  const current = readLockOwner();
  if (!current || current.token !== owner.token || current.pid !== owner.pid) {
    throw recoveryStateError("lock ownership changed unexpectedly");
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (error) {
    throw recoveryStateError("lock could not be released", error);
  }
}

export function withJournalLock<T>(operation: (requests: BoatCreateRequest[]) => T): T {
  const owner = acquireJournalLock();
  try {
    return operation(loadFresh());
  } finally {
    releaseJournalLock(owner);
  }
}

