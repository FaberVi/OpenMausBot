import { join } from "node:path";

import type { BeginTurnRequest, Coordinator, CoordinatorHost, CoordinatorOptions, HandoffOptions, HandoffView, HostTurnResult, LiveHandoffEdge, RoomAddress } from "./coordinator.ts";
import { composeEnvelope, envelopeNote } from "./runtime/envelope.ts";
import { Runtime } from "./runtime/runtime.ts";
import { importLegacyDelegations, importLegacyHandoffs, type LegacyThreadResolver } from "./runtime/import-legacy.ts";
import { openRuntimeStore, type RuntimeStore } from "./runtime/store.ts";
import { childrenSince, isTerminal } from "./runtime/tree.ts";
import type { Assignment, EndResult, Owner, StatusView, TurnRunner } from "./runtime/types.ts";
import { coordinatorEnqueue } from "./runtime-coordinator-enqueue.ts";
import { coordinatorRunTurn } from "./runtime-coordinator-turn.ts";
import { runtimeOrigin, view } from "./runtime-coordinator-view.ts";

export { needsInputQuestion, view } from "./runtime-coordinator-view.ts";

const BRIEF_MAX = 12_000;

/** Per-turn stalls belong to the host's watchdog: this only keeps the runtime's window out of its way. */
const TURN_STALL_MS = 24 * 60 * 60_000;

const REQUESTS_PER_ROOT = 64;
const EXECUTIONS_PER_ROOT = 96;

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

export class RuntimeCoordinator implements Coordinator {
  private readonly host: CoordinatorHost;
  private readonly store: RuntimeStore;
  private readonly runtime: Runtime;
  private readonly legacyFile: string | undefined;
  private readonly legacyDir: string | undefined;
  private readonly legacyThreads: LegacyThreadResolver | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private opened = false;
  private prunedAt: number | undefined;

  constructor(options: CoordinatorOptions) {
    this.host = options.host;
    this.legacyDir = options.dataDir === ":memory:" ? undefined : options.dataDir;
    this.legacyFile = this.legacyDir === undefined ? undefined : join(this.legacyDir, "room-handoffs.json");
    this.legacyThreads = options.legacyThreads;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error("coordinator:", line));
    this.store = openRuntimeStore(options.dataDir === ":memory:" ? ":memory:" : join(options.dataDir, "runtime.db"));
    this.runtime = new Runtime(this.store, this.runner(), {
      clock: { now: () => this.now(), monotonic: () => performance.now() },
      limits: { depth: 4, requests: REQUESTS_PER_ROOT, executions: EXECUTIONS_PER_ROOT, turnStallMs: TURN_STALL_MS, ...options.runtimeLimits },
      ...(options.log ? { log: options.log } : {}),
    });
  }

  /** Not at construction: reconciling calls the host, which is still initialising then. */
  private ready(): void {
    if (this.opened) return;
    this.opened = true;
    if (this.legacyFile) {
      try {
        const imported = importLegacyHandoffs(this.store, this.legacyFile, this.now());
        if (imported) this.log(`imported ${imported} room-handoff rows from ${this.legacyFile}`);
      } catch (error) {
        this.log(`room-handoffs.json not imported: ${String(error)}`);
      }
    }
    if (this.legacyDir) {
      try {
        const imported = importLegacyDelegations(this.store, this.legacyDir, this.now(),
          { log: this.log, ...(this.legacyThreads ? { threads: this.legacyThreads } : {}) });
        if (imported) this.log(`imported ${imported} delegation-ledger rows from ${this.legacyDir}`);
      } catch (error) {
        this.log(`delegations.json not imported: ${String(error)}`);
      }
    }
    this.runtime.open();
  }

  node(id: string): HandoffView | undefined {
    this.ready();
    const a = this.store.get(id);
    return a && this.project(a);
  }

  has(id: string): boolean {
    this.ready();
    return this.store.get(id) !== undefined;
  }

  all(): HandoffView[] {
    this.ready();
    const rows = this.store.all();
    const byId = new Map(rows.map(row => [row.id, row]));
    return rows.map(row => view(row, row.parentId ? byId.get(row.parentId) : undefined));
  }

  active(): HandoffView[] {
    this.ready();
    return this.live().map(row => this.project(row));
  }

  children(id: string): HandoffView[] {
    this.ready();
    const parent = this.store.get(id);
    return this.store.children(id).map(child => view(child, parent));
  }

  enqueue(source: RoomAddress, generation: string, parentId: string | undefined, target: RoomAddress, text: string,
    options: HandoffOptions = {}): { node: HandoffView; duplicate: boolean } {
    this.ready();
    return coordinatorEnqueue(this.store, this.runtime, this.host, a => this.project(a), source, generation, parentId, target, text, options);
  }

  status(id: string): StatusView | undefined {
    this.ready();
    return this.runtime.status(id);
  }

  job(threadId: string, since: number, botId?: string): { scopes: string[]; rows: Assignment[] } {
    this.ready();
    const given = new Map<string, Assignment>();
    for (const a of this.store.all({ ownerThreadId: threadId, roots: true, openSince: since })) {
      if (a.assignee.destination.threadId === threadId) given.set(a.id, a);
    }
    if (botId) for (const a of this.store.all({ assignee: { botId, threadId }, openSince: since })) given.set(a.id, a);
    const rows = new Map<string, Assignment>();
    const scopes: string[] = [];
    for (const start of [...given.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (rows.has(start.id)) continue;
      scopes.push(start.id);
      const subtree = start.parentId ? this.subtree(start) : this.store.all({ rootId: start.id });
      for (const a of subtree) rows.set(a.id, a);
    }
    return { scopes, rows: [...rows.values()].sort((a, b) => a.createdAt - b.createdAt) };
  }

  private subtree(start: Assignment): Assignment[] {
    const out = [start];
    const seen = new Set([start.id]);
    for (let i = 0; i < out.length; i++) {
      for (const child of this.store.children(out[i]!.id)) if (!seen.has(child.id)) { seen.add(child.id); out.push(child); }
    }
    return out;
  }

  poll(owner: Owner): { items: StatusView["inbox"]; assignments: HandoffView[] } {
    this.ready();
    const polled = this.runtime.poll(owner);
    return { items: polled.items, assignments: polled.assignments.map(a => this.project(a)) };
  }

  outstandingFor(threadId: string): HandoffView[] {
    this.ready();
    const live = this.live();
    const mine = new Set(live.filter(a => a.assignee.destination.threadId === threadId).map(a => a.id));
    return live.filter(a => a.parentId !== undefined && mine.has(a.parentId) && a.reply !== "none").map(a => this.project(a));
  }

  beginTurn(req: BeginTurnRequest): HandoffView {
    this.ready();
    const existing = this.store.get(req.id);
    if (existing) return this.project(existing);
    const { address, opener } = req;
    const row = this.runtime.begin({
      id: req.id,
      origin: opener?.origin ?? runtimeOrigin(req.origin, address),
      requester: opener
        ? { ...opener.requester, botId: opener.requester.botId ?? address.botId, threadId: opener.requester.threadId ?? address.threadId, chief: this.host.chiefOf(address) }
        : { kind: "person", threadId: address.threadId, botId: address.botId, chief: this.host.chiefOf(address) },
      assignee: { botId: address.botId, destination: { kind: address.groupId ? "room_thread" : "standing_thread", threadId: address.threadId,
        ...(address.groupId ? { groupId: address.groupId } : {}) } },
      brief: req.brief.slice(0, BRIEF_MAX),
      level: req.level,
      ...(opener?.requester.kind === "external_runtime" ? { reply: "poll" as const } : {}),
      ...(req.goalRunId ? { goalRunId: req.goalRunId } : {}),
    });
    return this.project(row);
  }

  endTurn(id: string, result: HostTurnResult): void {
    this.ready();
    const cards = result.cards && result.cards.ids.length > 0 ? result.cards : undefined;
    const end: EndResult = { ok: result.ok, text: result.text, ...(result.evidence ? { evidence: result.evidence } : {}),
      ...(cards ? { needsInput: { question: cards.question, cards: cards.ids } } : {}),
      ...(result.cap ? { continue: { note: result.cap.note, ...(result.cap.handoffPath ? { handoffPath: result.cap.handoffPath } : {}) } } : {}),
      ...(result.stalled ? { stalled: true } : {}) };
    this.runtime.end(id, end);
  }

  answerNode(id: string, text: string): boolean {
    this.ready();
    const a = this.store.get(id);
    if (!a || a.status !== "needs_input") return false;
    return this.runtime.answer(id, text);
  }

  answerRoot(id: string, text: string): boolean {
    return this.answerNode(id, text);
  }

  parkedDirect(threadId: string): HandoffView | undefined {
    this.ready();
    const a = this.live().find(n => n.parentId === undefined && n.status === "needs_input" && this.direct(n, threadId));
    return a && this.project(a);
  }

  prune(before: number): number {
    this.ready();
    return this.runtime.prune(before);
  }

  sharedRequest(node: HandoffView): { id: string; botIds: string[] } {
    this.ready();
    const batch = node.groupId && node.requestBatchKey && node.parentId
      ? this.store.children(node.parentId).filter(c => c.batchKey === node.requestBatchKey && c.assignee.destination.groupId === node.groupId &&
        c.assignee.destination.threadId === node.threadId && c.brief === node.text)
      : [];
    if (batch.length === 0) return { id: node.id, botIds: [node.botId] };
    return { id: batch[0]!.id, botIds: batch.map(c => c.assignee.botId) };
  }

  cancelRoom(groupId: string, threadId?: string, reason = "Stopped by user", status: "failed" | "cancelled" = "cancelled"): void {
    this.ready();
    for (const n of this.live()) {
      if (n.assignee.destination.groupId !== groupId || (threadId && n.assignee.destination.threadId !== threadId)) continue;
      this.runtime.cancel(n.id, reason, status === "failed" ? "failed" : "stopped");
    }
  }

  cancelDirect(threadId: string, reason = "Stopped by user"): void {
    this.ready();
    for (const n of this.live()) if (this.direct(n, threadId)) this.runtime.cancel(n.id, reason, "stopped");
  }

  stopAwaitingDirect(threadId: string, reason = "Stopped by user"): HandoffView[] {
    this.ready();
    return this.runtime.stopRequester({ threadId }, reason).map(a => this.project(a));
  }

  activeDirect(threadId: string): boolean {
    this.ready();
    return this.live().some(n => this.direct(n, threadId));
  }

  assignerOf(threadId: string): HandoffView | undefined {
    this.ready();
    for (const n of this.live()) {
      if (!n.parentId || !this.direct(n, threadId)) continue;
      const parent = this.store.get(n.parentId);
      if (parent && !isTerminal(parent)) return this.project(parent);
    }
    return undefined;
  }

  outstandingDirect(threadId: string): HandoffView[] {
    this.ready();
    const out: HandoffView[] = [];
    for (const n of this.live()) {
      if (!n.parentId || n.reply === "none") continue;
      const parent = this.store.get(n.parentId);
      if (parent && !isTerminal(parent) && this.direct(parent, threadId)) out.push(view(n, parent));
    }
    return out;
  }

  awaitingTeammateThreads(): Set<string> {
    this.ready();
    const threads = new Set<string>();
    for (const n of this.live()) {
      const parent = n.parentId && n.reply !== "none" ? this.store.get(n.parentId) : undefined;
      if (parent && !isTerminal(parent) && parent.assignee.destination.groupId === undefined) threads.add(parent.assignee.destination.threadId);
      const root = view(n);
      if (!root.parentId && !root.groupId && (root.status === "resume" || (root.status === "waiting" && root.question === undefined && !root.cards?.length))) {
        threads.add(root.threadId);
      }
    }
    return threads;
  }

  liveEdges(): LiveHandoffEdge[] {
    this.ready();
    return this.runtime.liveEdges().map(edge => ({
      sourceBotId: edge.sourceBotId, targetBotId: edge.targetBotId, state: edge.state === "queued" ? "queued" : "running",
      threadId: edge.threadId, ...(edge.groupId !== undefined ? { groupId: edge.groupId } : {}),
    }));
  }

  continuesAfterRestart(threadId: string): boolean {
    this.ready();
    return this.live().some(n => n.assignee.destination.threadId === threadId && (
      (n.status === "running" && (n.restart !== "rerun" || childrenSince(this.store, n).length > 0)) ||
      ((n.status === "queued" || n.status === "resume") && n.restart === "rerun")));
  }

  note(id: string): string | undefined {
    this.ready();
    const a = this.store.get(id);
    if (!a) return undefined;
    const parent = a.parentId ? this.store.get(a.parentId) : undefined;
    return envelopeNote(composeEnvelope(a, this.host.names(this.project(a), parent && this.project(parent)), parent));
  }

  tick(): void {
    this.ready();
    this.pruneDaily();
    this.runtime.tick();
  }

  private pruneDaily(): void {
    const now = this.now();
    if (this.prunedAt !== undefined && now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    try {
      const removed = this.runtime.prune(now - PRUNE_AFTER_MS);
      if (removed > 0) this.log(`pruned ${removed} assignment rows of trees that finished more than 30 days ago`);
    } catch (error) {
      this.log(`prune failed: ${String(error)}`);
    }
  }

  close(): void {
    this.runtime.close();
  }

  progress(threadId: string): void {
    this.ready();
    for (const n of this.live()) if (n.status === "running" && n.assignee.destination.threadId === threadId) this.runtime.progress(n.id);
  }

  answer(threadId: string, text: string): boolean {
    this.ready();
    const parked = this.live().find(n => n.parentId !== undefined && n.status === "needs_input" && !(n.cards && n.cards.length > 0) &&
      n.assignee.destination.threadId === threadId);
    return parked ? this.runtime.answer(parked.id, text) : false;
  }

  awaitingAnswer(threadId: string): boolean {
    this.ready();
    return this.parkedIn(threadId) !== undefined;
  }

  private runner(): TurnRunner {
    const host = this.host;
    return {
      validate: (a, parent) => host.validate(view(a, parent), parent && this.project(parent)),
      canStart: a => !host.busy(this.project(a)),
      run: (a, input, signal) => coordinatorRunTurn(host, this.store, (c, p, pv) => this.readable(c, p, pv), a => this.project(a), a, input, signal),
      park: (a, question, restored) => host.park(this.project(a), question, restored),
      report: (a, parent) => host.report(view(a, parent), parent && this.project(parent)),
      changed: rows => {
        const groups = new Set<string>();
        const threads = new Set<string>();
        for (const row of rows) {
          const groupId = row.assignee.destination.groupId;
          if (groupId) groups.add(groupId); else threads.add(row.assignee.destination.threadId);
        }
        host.changed(groups, threads);
      },
      names: (a, parent) => host.names(view(a, parent), parent && this.project(parent)),
      outward: a => host.outward ? host.outward(this.project(a)) : [],
    };
  }

  private live(): Assignment[] {
    return this.store.all({ nonTerminal: true });
  }

  private parkedIn(threadId: string): Assignment | undefined {
    return this.live().find(n => n.status === "needs_input" && n.assignee.destination.threadId === threadId);
  }

  private direct(a: Assignment, threadId: string): boolean {
    return a.assignee.destination.groupId === undefined && a.assignee.destination.threadId === threadId;
  }

  /** A route or membership that no longer admits the child withholds its words; only the reason travels. */
  private readable(child: Assignment, parent: Assignment, parentView: HandoffView): Assignment {
    const problem = this.host.validate(view(child, parent), parentView);
    if (!problem) return child;
    const { evidence: _evidence, question: _question, ...rest } = child;
    return { ...rest, result: `${child.question === undefined ? "Result" : "Question"} withheld: ${problem}` };
  }

  private project(a: Assignment): HandoffView {
    return view(a, a.parentId ? this.store.get(a.parentId) : undefined);
  }
}
