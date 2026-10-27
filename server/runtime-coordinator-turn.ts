import type { CoordinatorHost, HandoffView, HostTurnResult } from "./coordinator.ts";
import { composeQuestion, composeReport, composeResume, composeRootTurn, continuationLine, envelopeNote } from "./runtime/envelope.ts";
import type { RuntimeStore } from "./runtime/store.ts";
import type { Assignment, RunInput, RunResult } from "./runtime/types.ts";
import { needsInputQuestion, view } from "./runtime-coordinator-view.ts";

export type CoordinatorReadable = (
  child: Assignment,
  parent: Assignment,
  parentView: HandoffView,
) => Assignment;

export async function coordinatorRunTurn(
  host: CoordinatorHost,
  store: RuntimeStore,
  readable: CoordinatorReadable,
  project: (a: Assignment) => HandoffView,
  a: Assignment,
  input: RunInput,
  signal: AbortSignal,
): Promise<RunResult> {
  const parent = a.parentId ? store.get(a.parentId) : undefined;
  const node = view(a, parent);
  const resumed = input.turn === "resume";
  const settled = input.settled ?? [];
  const asked = input.asked ?? [];
  const root = a.parentId === undefined;
  const body = resumed
    ? composeResume(a, host.names(node, parent && project(parent)),
      settled.map((child) => composeReport(readable(child, a, node), host.names(view(child, a), node))),
      asked.map((child) => composeQuestion(readable(child, a, node), host.names(view(child, a), node))))
    : root
      ? composeRootTurn(a, { turn: input.turn === "resume" ? "first" : input.turn, restartNote: "", ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}) })
      : input.continuation ? `${continuationLine(input.continuation)}\n${input.envelope}` : input.envelope;
  const note = resumed || root ? body : envelopeNote(body);
  const evidence = (result: HostTurnResult) => result.evidence ? { evidence: result.evidence } : {};
  const result = await host.run(node, resumed, signal,
    { text: `${input.restartNote}${body}`, note: `${input.restartNote}${note}`, restartNote: input.restartNote, turn: input.turn });
  if (signal.aborted) return { kind: "failed", outcome: "stopped", text: result.text };
  if (result.cap) return { kind: "continue", text: result.text, note: result.cap.note, ...(result.cap.handoffPath ? { handoffPath: result.cap.handoffPath } : {}), ...evidence(result) };
  if (result.cards) return { kind: "needs_input", question: result.cards.question, cards: result.cards.ids, ...evidence(result) };
  if (!result.ok) return { kind: "failed", outcome: result.stalled ? "stalled" : "provider_error", text: result.text, ...evidence(result) };
  const question = root ? undefined : needsInputQuestion(result.text);
  if (question !== undefined) return { kind: "needs_input", question, ...evidence(result) };
  return { kind: "completed", text: result.text, ...evidence(result) };
}
