import { randomUUID } from "node:crypto";

import { recoveryStateError, save, withJournalLock } from "./boat-create-journal-lock.ts";

const KEY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_REQUESTS = 4_096;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOAT_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export interface BoatCreateRequest {
  botId: string;
  requestBody: string;
  idempotencyKey: string;
  createdAt: number;
  boxId?: string;
  /** The Boat carries its deterministic name; until then deleting the bot would orphan an ambiguous Boat. */
  resolved?: true;
}

export interface BoatCreateAttempt {
  request: BoatCreateRequest;
  /** Process-local on purpose: a resumed key may resolve an earlier run's Boat and must never authorize automatic cleanup. */
  startedNow: boolean;
}

export interface BoatCreateRecoverySnapshot {
  botId: string;
  boxId?: string;
  resolved: boolean;
}

export { recoveryStateError };

/** Recorded before the request leaves the process; a known Boat wins over a changed body, never a second create. */
export function beginBoatCreate(botId: string, requestBody: string): BoatCreateAttempt {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer creation");
  if (!requestBody || requestBody.length > 1_024) throw new Error("invalid cloud computer create request");
  return withJournalLock((requests) => {
    const known = requests.find((request) => request.botId === botId && request.boxId);
    if (known) return { request: { ...known }, startedNow: false };

    const now = Date.now();
    const pending = requests.find((request) => request.botId === botId);
    if (pending) {
      if (pending.requestBody !== requestBody) {
        throw recoveryStateError("waiting for an earlier cloud computer request to be reconciled");
      }
      if (now - pending.createdAt >= KEY_RETENTION_MS) {
        // Past boat.dev's 24-hour idempotency window a retry or new key may create a second billable Boat; stop for manual reconciliation.
        throw recoveryStateError("older than boat.dev's 24-hour retry window");
      }
      return { request: { ...pending }, startedNow: false };
    }

    const request: BoatCreateRequest = {
      botId,
      requestBody,
      idempotencyKey: randomUUID(),
      createdAt: now,
    };
    if (requests.length >= MAX_REQUESTS) throw recoveryStateError("full");
    save([...requests, request]);
    return { request: { ...request }, startedNow: true };
  });
}

/** Persist the returned identity before the caller attempts to rename it. */
export function rememberCreatedBoat(request: BoatCreateRequest, boxId: string): BoatCreateRequest {
  if (!BOAT_ID.test(boxId)) throw new Error("boat.dev returned an invalid cloud computer id");
  return withJournalLock((requests) => {
    const current = requests.find((candidate) => (
      candidate.botId === request.botId
      && candidate.requestBody === request.requestBody
      && candidate.idempotencyKey === request.idempotencyKey
    ));
    if (!current || (current.boxId !== undefined && current.boxId !== boxId)) {
      throw recoveryStateError("out of date");
    }
    const completed = { ...current, boxId };
    save([...requests.filter((candidate) => candidate.botId !== request.botId), completed]);
    return { ...completed };
  });
}

/** Only after the deterministic rename succeeds. */
export function resolveBoatCreate(request: BoatCreateRequest): BoatCreateRequest {
  return withJournalLock((requests) => {
    const current = requests.find((candidate) => (
      candidate.botId === request.botId
      && candidate.requestBody === request.requestBody
      && candidate.idempotencyKey === request.idempotencyKey
      && candidate.boxId === request.boxId
    ));
    if (!current?.boxId) throw recoveryStateError("out of date");
    const resolved: BoatCreateRequest = { ...current, resolved: true };
    save(requests.map((candidate) => candidate.idempotencyKey === current.idempotencyKey ? resolved : candidate));
    return { ...resolved };
  });
}

/** Provider request bodies and idempotency keys never cross this boundary. */
export function boatCreateRecoverySnapshot(): BoatCreateRecoverySnapshot[] {
  return withJournalLock((requests) => requests.map((request) => ({
    botId: request.botId,
    ...(request.boxId ? { boxId: request.boxId } : {}),
    resolved: request.resolved === true,
  })));
}

/** Never steals an identity remembered for another bot; fails closed on a cross-bot conflict. */
export function adoptResolvedBoat(botId: string, boxId: string): void {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer ownership");
  if (!BOAT_ID.test(boxId)) throw new Error("invalid cloud computer id for ownership");
  withJournalLock((requests) => {
    const sameBoat = requests.find((request) => request.boxId === boxId);
    if (sameBoat && sameBoat.botId !== botId) {
      throw recoveryStateError("conflicted with another bot's remembered cloud computer");
    }
    const adopted: BoatCreateRequest = sameBoat
      ? { ...sameBoat, resolved: true }
      : {
          botId,
          requestBody: JSON.stringify({ adopted: "legacy-name", boxId }),
          idempotencyKey: randomUUID(),
          createdAt: Date.now(),
          boxId,
          resolved: true,
        };
    const retained = requests.filter((request) => request.botId !== botId);
    if (retained.length >= MAX_REQUESTS) throw recoveryStateError("full");
    if (
      requests.filter((request) => request.botId === botId).length === 1
      && sameBoat?.resolved === true
      && sameBoat.botId === botId
    ) return;
    save([...retained, adopted]);
  });
}

/** Only for a Boat the provider confirmed deleted, never a failed or ambiguous deletion. */
export function retireDeletedBoatCreate(boxId: string): void {
  if (!BOAT_ID.test(boxId)) throw new Error("invalid deleted cloud computer id");
  withJournalLock((requests) => {
    const next = requests.filter((request) => request.boxId !== boxId);
    if (next.length !== requests.length) save(next);
  });
}

export function discardBoatCreate(request: BoatCreateRequest): void {
  withJournalLock((requests) => {
    const next = requests.filter((candidate) => candidate.idempotencyKey !== request.idempotencyKey);
    if (next.length !== requests.length) save(next);
  });
}
