import type { CalendarCall } from "@/lib/calendar-calls";
import type { CallOccurrence, RoutineCalendarItem } from "@/lib/routine-calendar";
import type { Routine } from "@/lib/routines";

export type EventKind = "routine" | "call";
export type RoutinesLayout = "day" | "week" | "list";

export type CalendarEventItem =
  | ({ kind: "routine" } & RoutineCalendarItem)
  | ({ kind: "call" } & CallOccurrence);

export type EventSeed = {
  kind: EventKind;
  at: number;
  durationMinutes: number;
  botIds: string[];
  name?: string;
  description?: string;
  resultsThreadId?: string | null;
  /** Dropped on an engine's reset marker: it runs when that limit resets, not at `at`. */
  limitReset?: { engine: string };
  anchor?: { x: number; y: number };
  routine?: Routine;
  call?: CalendarCall;
};

export function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}
