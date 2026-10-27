const MAX_RECORDS = 4_096;
const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const BOAT_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const PROVIDER_STATUSES = new Set(["pending", "processing", "blocked", "completed"]);

export type BoatDeletionPhase = "prepared" | "accepted" | "blocked";
export type BoatDeletionStatus = "pending" | "processing" | "blocked" | "completed";

export interface BoatDeletionRecord {
  boxId: string;
  name: string;
  ownerBotId: string | null;
  phase: BoatDeletionPhase;
  operationId?: string;
  status?: BoatDeletionStatus;
  requestedAt: number;
  updatedAt: number;
}

export interface BoatDeletionIdentity {
  boxId: string;
  name: string;
  ownerBotId: string | null;
}

export interface BoatDeletionOperationReceipt {
  id: string;
  kind: "sandbox";
  targetId: string;
  status: BoatDeletionStatus;
}

import { clone, nextUpdatedAt, save, stateError, validName, withJournalLock } from "./boat-delete-journal-lock.ts";

export { stateError };

function validateIdentity(identity: BoatDeletionIdentity): void {
  if (!BOAT_ID.test(identity.boxId)) throw new Error("invalid cloud computer id for deletion");
  if (!validName(identity.name)) throw new Error("invalid cloud computer name for deletion");
  if (!(identity.ownerBotId === null || BOT_ID.test(identity.ownerBotId))) {
    throw new Error("invalid cloud computer owner for deletion");
  }
}

function parseOperation(
  boxId: string,
  value: unknown,
  expectedStatus?: BoatDeletionStatus,
): BoatDeletionOperationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid cloud computer deletion operation");
  }
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.id !== "string"
    || !OPERATION_ID.test(operation.id)
    || operation.kind !== "sandbox"
    || operation.targetId !== boxId
    || typeof operation.status !== "string"
    || !PROVIDER_STATUSES.has(operation.status)
    || (expectedStatus !== undefined && operation.status !== expectedStatus)
  ) throw new Error("invalid or mismatched cloud computer deletion operation");
  return operation as unknown as BoatDeletionOperationReceipt;
}

/** The immutable target is written before DELETE is sent; in-flight work wins, and a blocked operation may be retried explicitly. */
export function prepareBoatDeletion(identity: BoatDeletionIdentity): BoatDeletionRecord {
  validateIdentity(identity);
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === identity.boxId);
    if (existing) {
      if (existing.name !== identity.name || existing.ownerBotId !== identity.ownerBotId) {
        throw stateError("conflicted with the remembered deletion target");
      }
      if (existing.phase !== "blocked") return clone(existing);
    }
    if (!existing && records.length >= MAX_RECORDS) throw stateError("full");
    const now = Date.now();
    const prepared: BoatDeletionRecord = {
      ...identity,
      phase: "prepared",
      requestedAt: now,
      updatedAt: now,
    };
    save([...records.filter((record) => record.boxId !== identity.boxId), prepared]);
    return clone(prepared);
  });
}

/** Binds a provider receipt to this exact target, so another Boat's operation can never attach to the fence. */
export function markBoatDeletionAccepted(boxId: string, value: unknown): BoatDeletionRecord {
  if (!BOAT_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  const operation = parseOperation(boxId, value);
  if (operation.status === "blocked") {
    throw new Error("blocked cloud computer deletion must use markBoatDeletionBlocked");
  }
  const acceptedStatus = operation.status;
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === boxId);
    if (!existing || existing.phase === "blocked") throw stateError("out of date");
    if (existing.operationId && existing.operationId !== operation.id) {
      throw stateError("conflicted with another deletion operation");
    }
    if (records.some((record) => record.boxId !== boxId && record.operationId === operation.id)) {
      throw stateError("conflicted with another deletion operation");
    }
    const ranks: Record<Exclude<BoatDeletionStatus, "blocked">, number> = {
      pending: 0,
      processing: 1,
      completed: 2,
    };
    if (
      existing.phase === "accepted"
      && existing.status !== undefined
      && existing.status !== "blocked"
      && ranks[acceptedStatus] < ranks[existing.status]
    ) return clone(existing);
    const accepted: BoatDeletionRecord = {
      ...existing,
      phase: "accepted",
      operationId: operation.id,
      status: acceptedStatus,
      updatedAt: nextUpdatedAt(existing),
    };
    save(records.map((record) => record.boxId === boxId ? accepted : record));
    return clone(accepted);
  });
}

/** The target stays fenced; only a deliberate deletion retry may prepare it again. */
export function markBoatDeletionBlocked(boxId: string, value?: unknown): BoatDeletionRecord {
  if (!BOAT_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  const operation = value === undefined ? null : parseOperation(boxId, value, "blocked");
  return withJournalLock((records) => {
    const existing = records.find((record) => record.boxId === boxId);
    if (!existing) throw stateError("out of date");
    if (operation && existing.operationId && existing.operationId !== operation.id) {
      throw stateError("conflicted with another deletion operation");
    }
    if (
      operation
      && records.some((record) => record.boxId !== boxId && record.operationId === operation.id)
    ) throw stateError("conflicted with another deletion operation");
    const blocked: BoatDeletionRecord = {
      ...existing,
      phase: "blocked",
      ...(operation?.id || existing.operationId ? { operationId: operation?.id ?? existing.operationId } : {}),
      status: "blocked",
      updatedAt: nextUpdatedAt(existing),
    };
    save(records.map((record) => record.boxId === boxId ? blocked : record));
    return clone(blocked);
  });
}

export function boatDeletionSnapshot(): BoatDeletionRecord[] {
  return withJournalLock((records) => records.map(clone));
}

export function getBoatDeletion(boxId: string): BoatDeletionRecord | null {
  if (!BOAT_ID.test(boxId)) throw new Error("invalid cloud computer id for deletion");
  return withJournalLock((records) => {
    const record = records.find((candidate) => candidate.boxId === boxId);
    return record ? clone(record) : null;
  });
}

export function hasPendingBoatDeletionForBot(botId: string): boolean {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id for cloud computer deletion");
  return withJournalLock((records) => records.some((record) => record.ownerBotId === botId));
}

/** Only after a direct absence or a completed target-bound operation proves the Boat is gone. */
export function retireBoatDeletion(boxId: string): void {
  if (!BOAT_ID.test(boxId)) throw new Error("invalid deleted cloud computer id");
  withJournalLock((records) => {
    const next = records.filter((record) => record.boxId !== boxId);
    if (next.length !== records.length) save(next);
  });
}
