import type { HandoffView, RoomAddress } from "./coordinator.ts";
import type { WorkOrigin } from "./peer-provenance.ts";
import type { Assignment, Origin } from "./runtime/types.ts";

const NEEDS_INPUT = /^needs input:/i;

const hostFirstTurn = (a: Assignment): boolean => !a.parentId && a.status === "running" && a.executions === 1;

export const handoffKindOf = (groupId: string | undefined, parent: Assignment | undefined): HandoffView["kind"] =>
  groupId !== undefined && parent?.assignee.destination.groupId === groupId ? "assignment" : "work";

function legacyOrigin(origin: Origin): WorkOrigin | undefined {
  if (origin.kind !== "person") return { kind: "outside" };
  return origin.quote ? { kind: "user", request: origin.quote } : undefined;
}

export function runtimeOrigin(origin: WorkOrigin | undefined, source: RoomAddress): Origin {
  return origin?.kind === "user"
    ? { kind: "person", source: "chat", ref: source.threadId, quote: origin.request }
    : { kind: "outside", source: "chat", ref: source.threadId };
}

export const assignmentAddress = (a: Assignment): RoomAddress => {
  const { groupId, threadId } = a.assignee.destination;
  return { threadId, botId: a.assignee.botId, ...(groupId !== undefined ? { groupId } : {}) };
};

export const sameSpeaker = (a: Assignment, source: RoomAddress): boolean =>
  a.assignee.destination.groupId === source.groupId && a.assignee.destination.threadId === source.threadId && a.assignee.botId === source.botId;

export const ancestorOf = (ancestor: RoomAddress, target: RoomAddress): boolean =>
  ancestor.botId === target.botId && (!ancestor.groupId || !target.groupId || ancestor.groupId === target.groupId);

export function needsInputQuestion(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  if (last < 0) return undefined;
  const line = lines[last]!.trim();
  if (!NEEDS_INPUT.test(line)) return undefined;
  const question = [line.slice("NEEDS INPUT:".length), ...lines.slice(last + 1)].join("\n").trim();
  return question || undefined;
}

export function view(a: Assignment, parent?: Assignment): HandoffView {
  const groupId = a.assignee.destination.groupId;
  const status: HandoffView["status"] = hostFirstTurn(a) ? "source" : a.status === "needs_input" ? "waiting" : a.status;
  const node: HandoffView = {
    id: a.id, rootId: a.rootId, threadId: a.assignee.destination.threadId, botId: a.assignee.botId, key: a.assignee.botId,
    text: a.brief, createdAt: a.createdAt, status, result: a.result, reported: a.reportedAt !== undefined, executions: a.executions,
    lastProgressAt: a.lastActivityAt, approvalGranted: a.approved ?? false, kind: handoffKindOf(groupId, parent), restarts: a.restarts,
    mode: a.mode, reply: a.reply,
  };
  if (a.outcome !== undefined) node.outcome = a.outcome;
  if (a.outcomeDetail !== undefined) node.outcomeDetail = a.outcomeDetail;
  if (a.question !== undefined) node.question = a.question;
  if (a.cards !== undefined) node.cards = a.cards;
  if (a.continuation !== undefined) node.continuation = { ...a.continuation };
  if (a.goalRunId !== undefined) node.goalRunId = a.goalRunId;
  if (a.parentId !== undefined) node.parentId = a.parentId;
  if (groupId !== undefined) node.groupId = groupId;
  if (a.batchKey !== undefined) node.requestBatchKey = a.batchKey;
  if (a.startedAt !== undefined) node.startedAt = a.startedAt;
  const origin = legacyOrigin(a.origin);
  if (origin) node.origin = origin;
  if (a.restart !== undefined) node.restart = a.restart;
  return node;
}
