import type { CoordinatorHost, HandoffOptions, HandoffView, RoomAddress } from "./coordinator.ts";
import { Runtime } from "./runtime/runtime.ts";
import type { RuntimeStore } from "./runtime/store.ts";
import { clip, isTerminal, path } from "./runtime/tree.ts";
import type { Assignment, Reply, Requester } from "./runtime/types.ts";
import {
  ancestorOf,
  assignmentAddress,
  handoffKindOf,
  sameSpeaker,
  view,
} from "./runtime-coordinator-view.ts";

const NOT_RUNNING = "The originating room task is no longer running";
const WRONG_SPEAKER = "The handoff belongs to a different room speaker";
const ANCESTOR = "Cannot assign work back to an ancestor; results return automatically";
const ALREADY_COMPLETED = "This agent already completed your assignment. Do not send acknowledgements or approvals as new work. Finish with your decision; results return automatically. Only use rework=true for concrete additional work.";
const ROOM_ANCESTOR = "A room request cannot return to an ancestor room; results are returned automatically";
const DEPTH = "Room handoff depth limit reached";
const BUDGET = "Room handoff budget exhausted";
const NO_TURN = "The requesting turn has no root (no turn)";

const BRIEF_MAX = 12_000;
const RUNTIME_DEPTH = /^Assignment depth limit reached/;

export function coordinatorEnqueue(
  store: RuntimeStore,
  runtime: Runtime,
  host: CoordinatorHost,
  project: (a: Assignment) => HandoffView,
  source: RoomAddress,
  generation: string,
  parentId: string | undefined,
  target: RoomAddress,
  text: string,
  options: HandoffOptions = {},
): { node: HandoffView; duplicate: boolean } {
  const { approvalGranted = false, rework = false, requestBatchKey, thread } = options;
  const mode = options.mode ?? "work";
  const parent = parentId ? store.get(parentId) : store.get(generation);
  if (!parent) throw new Error(parentId ? NOT_RUNNING : NO_TURN);
  if (parent.status !== "running") throw new Error(NOT_RUNNING);
  if (!sameSpeaker(parent, source)) throw new Error(WRONG_SPEAKER);
  const brief = clip(text, BRIEF_MAX);
  const kind: HandoffView["kind"] = target.groupId !== undefined && target.groupId === source.groupId ? "assignment" : "work";
  const lineage = path(store, parent);
  const root = lineage[0]!;
  if (lineage.some(n => ancestorOf(assignmentAddress(n), target))) throw new Error(ANCESTOR);
  const siblings = store.children(parent.id);
  const existing = siblings.findLast(c => c.assignee.botId === target.botId && c.assignee.destination.groupId === target.groupId && c.brief === brief && c.mode === mode);
  if (existing && !(rework && isTerminal(existing))) return { node: view(existing, parent), duplicate: true };
  if (mode === "work" && !rework && siblings.some(c => c.mode === "work" && handoffKindOf(c.assignee.destination.groupId, parent) === kind &&
    c.assignee.destination.groupId === target.groupId && c.assignee.botId === target.botId && c.status === "completed")) throw new Error(ALREADY_COMPLETED);
  if (kind === "work" && target.groupId && lineage.some(n => n.assignee.destination.groupId === target.groupId)) throw new Error(ROOM_ANCESTOR);
  const wanted: Reply = mode === "notify" ? "none" : options.reply ?? "resume";
  const reply: Reply = wanted === "none" ? "none" : root.reply === "poll" ? "poll" : wanted;
  const requester: Requester = { kind: "bot_turn", botId: parent.assignee.botId, threadId: parent.assignee.destination.threadId,
    chief: host.chiefOf(assignmentAddress(parent)), ...(parent.id === root.id && root.requester.runId !== undefined ? { runId: root.requester.runId } : {}) };
  const level = host.levelOf(target, project(parent));
  const result = runtime.enqueue({
    parentId: parent.id,
    origin: parent.origin,
    requester,
    assignee: { botId: target.botId, destination: { kind: target.groupId ? "room_thread" : thread === "standing" ? "standing_thread" : "work_thread",
      threadId: target.threadId, ...(target.groupId ? { groupId: target.groupId } : {}) } },
    mode, reply, brief: text, rework,
    ...(options.doneWhen ? { doneWhen: options.doneWhen } : {}),
    levels: { own: level.level, ...(level.chief !== undefined ? { chief: level.chief } : {}) },
    ...(level.driverKind !== undefined ? { driverKind: level.driverKind } : {}),
    approved: approvalGranted,
    ...(target.groupId && requestBatchKey ? { batchKey: requestBatchKey } : {}),
  });
  if (!result.ok) {
    if (result.outcome === "budget") throw new Error(BUDGET);
    throw new Error(RUNTIME_DEPTH.test(result.reason) ? DEPTH : result.reason);
  }
  return { node: view(result.assignment, parent), duplicate: result.duplicate };
}
