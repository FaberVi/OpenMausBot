import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  ExternalLink,
  FileText,
  Laptop,
  Loader2,
  Pause,
  Play,
  Trash2,
  UserRoundPlus,
  UsersRound,
  Video,
  X,
  XCircle,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { ResultsDestination } from "@/components/routines/ResultsDestination";
import { CronSchedulePreview } from "@/components/routines/CronScheduleFields";
import { routineRunLabel, routineRunsOn, routineRunTime, routineScheduleState } from "@/lib/routine-display";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useShowThreads } from "@/lib/thread-preferences";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { CalendarCall, CalendarCallInput } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import {
  addDays,
  atLocalTime,
  CALENDAR_SLOT_MINUTES,
  formatGmtOffset,
  packCalendarCollisions,
  slotAt,
  startOfDay,
} from "@/lib/routine-calendar";
import { limitResetWhen, type ResetMarker } from "@/lib/limit-resets";
import { DAY_NAMES, durationLabel, intervalLabel, niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import { Select } from "./Select";
import {
  isRoutineProblemRun,
  type Routine,
  type RoutineInput,
  type RoutineRunOn,
  type RoutineRun,
  type RoutineRunStatus,
} from "@/lib/routines";
import { api, openBotThread, openNotificationTarget, useStore, type Bot, type Group } from "@/state/store";

const HOUR_HEIGHT = 64;
import { BOT_DRAG_TYPE, EVENT_DRAG_TYPE, LimitResetMarker, type ResetDrop } from "./routines/LimitResetMarkers";
import { AttachmentChips, BotPicker } from "./routine-calendar-editor-widgets";
import {
  type CalendarEventItem,
  type EventKind,
  type EventSeed,
  type RoutinesLayout,
  nextHour,
} from "./routine-calendar-types";

export type { CalendarEventItem, EventKind, EventSeed, RoutinesLayout };
import { EventEditor } from "./routine-calendar-event-editor";

export { EventEditor };
export { nextHour };

function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}


export function QuickComposer({
  seed,
  bots,
  routinesOnly = false,
  onClose,
  onMore,
  onSavedRoutine,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  routinesOnly?: boolean;
  onClose: () => void;
  onMore: (seed: EventSeed) => void;
  onSavedRoutine: (routine: Routine) => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const [kind, setKind] = useState<EventKind>(routinesOnly || seed.limitReset ? "routine" : seed.kind);
  const [name, setName] = useState(seed.name ?? "");
  const [description, setDescription] = useState(seed.description ?? "");
  const [botIds, setBotIds] = useState(seed.botIds.length ? seed.botIds : bots[0] ? [bots[0].id] : []);
  const [resultsThreadId, setResultsThreadId] = useState<string | null>(seed.resultsThreadId ?? null);
  const selectBots = (ids: string[]) => {
    if (ids[0] !== botIds[0]) setResultsThreadId(null);
    setBotIds(ids);
  };
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState<{ left: number; top: number } | null>(null);
  const durationMinutes = kind === "routine" ? 30 : seed.durationMinutes;

  useLayoutEffect(() => {
    if (!seed.anchor) {
      setDialogPosition(null);
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const place = () => {
      const gap = 12;
      const rect = dialog.getBoundingClientRect();
      let left = seed.anchor!.x + gap;
      let top = seed.anchor!.y + gap;
      if (left + rect.width > window.innerWidth - gap) left = seed.anchor!.x - rect.width - gap;
      if (top + rect.height > window.innerHeight - gap) top = seed.anchor!.y - rect.height - gap;
      setDialogPosition({
        left: Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap)),
        top: Math.max(gap, Math.min(top, window.innerHeight - rect.height - gap)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [kind, seed.anchor]);

  const save = async () => {
    setWorking(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const response = await api("/api/routines", {
          method: "POST",
          body: JSON.stringify({
            name,
            prompt: description,
            botId: botIds[0],
            runOn: "maus",
            enabled: true,
            schedule: seed.limitReset ? { type: "limit_reset", engine: seed.limitReset.engine, repeat: "once" } : { type: "once", at: seed.at },
            durationMinutes,
            attachments: [],
            resultsThreadId,
          } satisfies RoutineInput),
        });
        onSavedRoutine(response.routine);
      } else {
        const response = await api("/api/calendar-calls", {
          method: "POST",
          body: JSON.stringify({
            name,
            description,
            botIds,
            schedule: { type: "once", at: seed.at },
            durationMinutes,
          } satisfies CalendarCallInput),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const valid = Boolean(name.trim() && botIds.length && (kind === "call" || description.trim()));
  return (
    <div ref={dialogRef} role="dialog" aria-label="Quick create" style={dialogPosition ?? undefined} className={cn("fixed z-50 max-h-[calc(100vh-24px)] w-[min(430px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl", !dialogPosition && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")}>
      <div className="flex items-center justify-between bg-raised/70 px-4 py-2.5">
        <div className="text-[12px] font-medium text-ink-secondary">New calendar event</div>
        <button onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-inset hover:text-ink" aria-label="Close"><X size={16} /></button>
      </div>
      <div className="space-y-3 p-4">
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Add title" onKeyDown={(event) => { if (event.key === "Enter" && valid) void save(); }} className="w-full border-b border-hairline/60 bg-transparent pb-2 text-[18px] font-medium text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
        {!routinesOnly && !seed.limitReset && (
          <div className="flex items-center gap-1 border-b border-hairline/35 pb-2">
            <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "routine" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>{t("routines.kind.routine")}</button>
            <button type="button" onClick={() => setKind("call")} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "call" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>{t("routines.kind.call")}</button>
          </div>
        )}
        <div className="flex items-start gap-3 text-[13px] text-ink">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
          {seed.limitReset ? <div data-testid="quick-limit-reset">{limitResetWhen({ engine: seed.limitReset.engine, repeat: "once" })}</div> : <div><div>{niceDate(seed.at)}</div><div className="mt-0.5 text-ink-secondary">{niceTime(seed.at)}{kind === "call" ? ` – ${niceTime(seed.at + durationMinutes * 60_000)}` : ""}</div></div>}
        </div>
        <div className="flex items-start gap-3">
          <UserRoundPlus size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          {bots.length === 0 ? (
            <button type="button" onClick={() => { dispatch({ type: "toggleNewBot", open: true }); onClose(); }} className="min-w-0 flex-1 rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-3 py-3 text-left hover:bg-accent/10">
              <div className="text-[12px] font-medium text-accent">Create your first bot</div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">Then come back to schedule it.</div>
            </button>
          ) : kind === "routine" ? (
            <Select value={botIds[0] ?? ""} onChange={(event) => selectBots([event.target.value])} className="flex-1">
              <option value="">Assign a bot</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </Select>
          ) : (
            <div className="min-w-0 flex-1"><BotPicker bots={bots} selected={botIds} multiple onChange={selectBots} /></div>
          )}
        </div>
        <div className="flex items-start gap-3">
          <FileText size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={kind === "routine" ? "What should the bot do?" : "Add a description (optional)"} className="min-w-0 flex-1 resize-none rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
        </div>
        {kind === "routine" && <ResultsDestination bot={bots.find((bot) => bot.id === botIds[0])} value={resultsThreadId} onChange={(threadId) => setResultsThreadId(threadId ?? null)} />}
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
        <button onClick={() => onMore({ ...seed, kind, botIds, name, description, durationMinutes, resultsThreadId })} title="Choose repeating schedules and other options" className="rounded-lg px-3 py-2 text-[12px] font-medium text-accent hover:bg-accent/10">More options</button>
        <button onClick={save} disabled={!valid || working} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{working && <Loader2 size={13} className="animate-spin" />}Save</button>
      </div>
    </div>
  );
}

function CalendarEventCard({
  item,
  bots,
  groups,
  compact,
  layout,
  selected = false,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  groups: Group[];
  compact: boolean;
  layout: { column: number; columns: number };
  selected?: boolean;
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const roomId = isRoomGoal ? run?.groupId ?? routine?.groupId : undefined;
  const room = roomId ? groups.find((candidate) => candidate.id === roomId) ?? { name: t("routines.group") } : undefined;
  const ownerIds = isCall ? item.call.botIds : [run?.botId ?? routine?.botId ?? ""];
  const ownerBots = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = ownerBots[0];
  const name = isCall ? item.call.name : run?.routineName ?? routine?.name ?? "Automation";
  const color = isCall ? "var(--color-accent)" : primary ? MAUS_COLORS[primary.color] : "var(--color-ink-tertiary)";
  const paused = Boolean(routine && !run && !routine.enabled);
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const status = run?.status, attention = status === "failed" || status === "missed" || status === "waiting" || (item.kind === "routine" && !run && item.needsYou === true);
  const statusLabel = run ? routineRunLabel(run) : undefined;
  const canMove = isCall || Boolean(routine && !run && !paused && routine.schedule.type !== "cron");
  const schedule = isCall ? item.call.schedule : routine?.schedule;
  const recurring = Boolean(schedule && schedule.type !== "once");
  const intervalCadence = schedule?.type === "interval" ? intervalLabel(schedule.everyMinutes) : null;

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startDuration = previewDuration;
    let next = startDuration;
    const move = (pointer: PointerEvent) => {
      next = Math.max(CALENDAR_SLOT_MINUTES, Math.min(240, Math.round((startDuration + ((pointer.clientY - startY) / HOUR_HEIGHT) * 60) / CALENDAR_SLOT_MINUTES) * CALENDAR_SLOT_MINUTES));
      setPreviewDuration(next);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (next === item.durationMinutes) return;
      if (recurring && !window.confirm("Resize this entire recurring series?")) {
        setPreviewDuration(item.durationMinutes);
        return;
      }
      onResize(next);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  return (
    <button
      data-event-card
      type="button"
      draggable={canMove}
      title={routine?.schedule.type === "cron" ? "Open this automation to change its repeating schedule and time zone." : undefined}
      onDragStart={(event) => {
        if (!canMove) return event.preventDefault();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(EVENT_DRAG_TYPE, JSON.stringify({ kind: item.kind, id: isCall ? item.call.id : routine!.id, at: item.at }));
      }}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      aria-pressed={selected}
      aria-label={`${name}, ${niceTime(item.at)}${paused ? `, ${t("routines.pausedSchedule")}` : statusLabel ? `, ${statusLabel}` : ""}`}
      className={cn(
        "group absolute z-10 overflow-hidden rounded-md border border-l-[3px] text-left transition hover:z-20 focus:z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        previewDuration < 30 ? "px-1.5 py-0" : "px-1.5 py-1",
        paused && "border-dashed opacity-70",
        status === "cancelled" && "opacity-55",
        (status === "failed" || status === "missed") && "border-danger/60",
        selected && "z-20 ring-2 ring-accent ring-offset-1 ring-offset-app",
      )}
      style={{
        left: `calc(${(layout.column / layout.columns) * 100}% + 2px)`,
        width: `calc(${100 / layout.columns}% - 4px)`,
        top: `${((new Date(item.at).getHours() * 60 + new Date(item.at).getMinutes()) / 60) * HOUR_HEIGHT}px`,
        height: `${Math.max(16, (previewDuration / 60) * HOUR_HEIGHT)}px`,
        background: `color-mix(in srgb, ${color} ${paused ? 6 : 16}%, var(--color-card))`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        borderLeftColor: color,
        color: `color-mix(in srgb, ${color} 55%, var(--color-ink))`,
      }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {previewDuration >= 30 && (isCall ? <Video size={compact ? 11 : 13} className="mt-0.5 shrink-0" /> : primary ? <BotAvatar bot={primary} state={status ? statusState(status) : paused ? "sleeping" : "idle"} size={compact ? 18 : 22} animated={status === "running" || status === "waiting"} /> : null)}
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[11px] font-semibold", previewDuration < 30 ? "leading-none" : "leading-tight")}>{name}</div>
          {previewDuration >= 30 && <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] opacity-80">{!isCall && <span data-event-status={paused ? "paused" : attention ? "needs-you" : "working"} className={cn("size-1.5 shrink-0 rounded-full", paused ? "bg-ink-tertiary" : attention ? "bg-warning" : "bg-success")} />}<span className="truncate">{niceTime(item.at)} · {isCall ? t(ownerBots.length === 1 ? "routines.botCountOne" : "routines.botCountMany", { count: ownerBots.length }) : room ? room.name : intervalCadence ? `${primary?.name ?? ""} · ${intervalCadence}` : primary?.name}</span></div>}
        </div>
        {previewDuration >= 30 && ownerBots.length > 1 && <span className="rounded bg-inset/60 px-1 py-0.5 text-[8px]">+{ownerBots.length - 1}</span>}
      </div>
      {isCall && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label="Resize event"><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-current opacity-50" /></div>}
    </button>
  );
}

export function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  groups,
  selectedId,
  onOpen,
  onCreate,
  onMove,
  onResize,
  markers = [],
  onDropOnReset,
}: {
  anchor: number;
  days: number;
  items: CalendarEventItem[];
  markers?: ResetMarker[];
  onDropOnReset?: (drop: ResetDrop, marker: ResetMarker) => void;
  bots: Bot[];
  groups: Group[];
  selectedId?: string;
  onOpen: (item: CalendarEventItem) => void;
  onCreate: (seed: EventSeed) => void;
  onMove: (item: { kind: EventKind; id: string; at: number }, nextAt: number) => void;
  onResize: (item: CalendarEventItem, duration: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ day: number; start: number; end: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ day: number; at: number } | null>(null);
  const today = startOfDay(Date.now());
  const starts = Array.from({ length: days }, (_, index) => addDays(anchor, index));
  const minDayWidth = days === 7 ? 64 : days === 3 ? 180 : 280;
  const gridTemplateColumns = `64px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = 64 + days * minDayWidth;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const now = new Date();
    const hour = starts.includes(today) ? Math.max(0, now.getHours() - 2) : 7;
    viewport.scrollTo({ top: hour * HOUR_HEIGHT });
  }, [days]);

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-event-card]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    let end = start + 30 * 60_000;
    setSelection({ day, start, end });
    const move = (pointer: PointerEvent) => {
      const current = slotAt(day, pointer.clientY, rect.top, HOUR_HEIGHT);
      end = Math.max(start + CALENDAR_SLOT_MINUTES * 60_000, current + CALENDAR_SLOT_MINUTES * 60_000);
      setSelection({ day, start, end });
    };
    const up = (pointer: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setSelection(null);
      onCreate({ kind: "routine", at: start, durationMinutes: Math.max(CALENDAR_SLOT_MINUTES, Math.round((end - start) / 60_000)), botIds: [], anchor: { x: pointer.clientX, y: pointer.clientY } });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    event.preventDefault();
    setDragPreview(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (botId) return onCreate({ kind: "routine", at, durationMinutes: 30, botIds: [botId], anchor: { x: event.clientX, y: event.clientY } });
    const raw = event.dataTransfer.getData(EVENT_DRAG_TYPE);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: EventKind; id: string; at: number };
      onMove(item, at);
    } catch {
    }
  };

  const previewDrop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    if (!event.dataTransfer.types.includes(BOT_DRAG_TYPE) && !event.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(EVENT_DRAG_TYPE) ? "move" : "copy";
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    setDragPreview((current) => current?.day === day && current.at === at ? current : { day, at });
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-l border-t border-hairline/40 bg-app">
      <div className="sticky top-0 z-30 grid bg-app/95 backdrop-blur" style={{ gridTemplateColumns, minWidth }}>
        <div className="border-b border-r border-hairline/40 px-2 py-3 text-center text-[9px] uppercase tracking-wider text-ink-secondary">{formatGmtOffset(-new Date(anchor).getTimezoneOffset())}</div>
        {starts.map((start) => {
          const date = new Date(start);
          const isToday = start === today;
          return <div key={start} role="columnheader" className={cn("border-b border-r border-hairline/40 px-2 py-2 text-center last:border-r-0", isToday && "bg-accent/[0.035]")}><div className={cn("text-[10px] font-medium uppercase tracking-[0.14em]", isToday ? "text-accent" : "text-ink-secondary")}>{DAY_NAMES[date.getDay()]}</div><div className={cn("mx-auto mt-1 flex size-8 items-center justify-center rounded-full text-[15px] font-medium", isToday ? "bg-accent text-accent-ink" : "text-ink")}>{date.getDate()}</div></div>;
        })}
      </div>
      <div role="grid" aria-label="Routine and call calendar" onDragEnd={() => setDragPreview(null)} className="relative grid" style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns, minWidth }}>
        <div className="relative border-r border-hairline/40">
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-tertiary" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? "" : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</div>)}
        </div>
        {starts.map((start) => {
          const now = new Date();
          const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
          const dayItems = items.filter((item) => startOfDay(item.at) === start);
          const collisionLayouts = packCalendarCollisions(dayItems);
          const selected = selection?.day === start ? selection : null;
          const preview = dragPreview?.day === start ? dragPreview : null;
          return (
            <div key={start} role="gridcell" aria-label={`${niceDate(start)} calendar`} onPointerDown={(event) => beginSelection(event, start)} onDragOver={(event) => previewDrop(event, start)} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragPreview(null); }} onDrop={(event) => drop(event, start)} className={cn("relative border-r border-hairline/40 last:border-r-0", start === today && "bg-accent/[0.025]")}>
              {Array.from({ length: 48 }, (_, half) => <div key={half} className={cn("pointer-events-none absolute inset-x-0 border-t", half % 2 === 0 ? "border-hairline/30" : "border-hairline/10")} style={{ top: (half / 2) * HOUR_HEIGHT }} />)}
              {start === today && <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}><span className="-ml-1 size-2 rounded-full bg-danger" /><span className="h-px flex-1 bg-danger/80" /></div>}
              {selected && <div className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-accent/70 bg-accent/20" style={{ top: ((new Date(selected.start).getHours() * 60 + new Date(selected.start).getMinutes()) / 60) * HOUR_HEIGHT, height: Math.max(16, ((selected.end - selected.start) / 3_600_000) * HOUR_HEIGHT) }} />}
              {preview && <div className="pointer-events-none absolute inset-x-1 z-20 rounded-md border border-accent/80 bg-accent/25 shadow-sm" style={{ top: ((new Date(preview.at).getHours() * 60 + new Date(preview.at).getMinutes()) / 60) * HOUR_HEIGHT, height: HOUR_HEIGHT / 2 }}><div className="px-2 py-1 text-[10px] font-medium text-accent">{niceTime(preview.at)}</div></div>}
              {markers.filter((marker) => startOfDay(marker.at) === start).map((marker) => <LimitResetMarker key={marker.engine} marker={marker} hourHeight={HOUR_HEIGHT} onDrop={onDropOnReset && ((drop) => onDropOnReset(drop, marker))} />)}
              {dayItems.map((item) => <CalendarEventCard key={item.id} item={item} bots={bots} groups={groups} compact={days === 7} layout={collisionLayouts.get(item.id) ?? { column: 0, columns: 1 }} selected={item.id === selectedId} onOpen={() => onOpen(item)} onResize={(minutes) => onResize(item, minutes)} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EventDetails({
  item,
  bots,
  onClose,
  onEdit,
  onCallChanged,
  onOpenRoom,
  onOpenRun,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  onClose: () => void;
  onEdit: () => void;
  onCallChanged: (id: string | null) => void;
  onOpenRoom: (id: string) => void;
  onOpenRun?: (run: RoutineRun) => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const showThreads = useShowThreads();
  const [working, setWorking] = useState(false);
  const runNowPending = useRef(false);
  const [starting, setStarting] = useState(false);
  const [submittedRun, setSubmittedRun] = useState<RoutineRun | null | undefined>(undefined);
  const [error, setError] = useState("");
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = submittedRun === undefined
    ? item.kind === "routine" ? item.run : null
    : submittedRun && (state.routineRuns.find((candidate) => candidate.id === submittedRun.id) ?? submittedRun);
  const call = item.kind === "call" ? item.call : null;
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const goalGroupId = isRoomGoal ? run?.groupId ?? routine?.groupId : undefined;
  const goalGroup = state.groups.find((group) => group.id === goalGroupId);
  const executionThreadId = run?.executionThreadId ?? run?.threadId;
  const botIds = call?.botIds ?? [run?.botId ?? routine?.botId ?? ""];
  const invited = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = invited[0];
  const executionOwner = isRoomGoal && goalGroupId ? goalGroup : primary;
  const canOpenExecution = Boolean(executionThreadId && (executionOwner?.threadId === executionThreadId || executionOwner?.tasks?.some((task) => task.threadId === executionThreadId)));
  const resultsThreadId = run ? run.resultsThreadId ?? run.sourceThreadId : routine?.resultsThreadId;
  const openResultsId = resultsThreadId ?? (!run && routine?.target === "bot" ? primary?.mainThreadId : undefined);
  const canOpenResults = openResultsId && [...state.bots, ...state.groups].some((owner) => owner.threadId === openResultsId || owner.tasks?.some((task) => task.threadId === openResultsId));
  const title = call?.name ?? run?.routineName ?? routine?.name ?? "Routine";
  const description = call?.description ?? run?.prompt ?? routine?.prompt ?? "";
  const attachments = call?.attachments ?? run?.attachments ?? routine?.attachments ?? [];
  const roomId = call?.botIds.length === 1 ? primary?.id : undefined;
  const safetyLimit = run ? run.timeoutMinutes : routine?.timeoutMinutes;

  const openRunTask = () => {
    if (!executionThreadId) return;
    if (isRoomGoal && goalGroupId) {
      dispatch({ type: "switchGroupTask", groupId: goalGroupId, threadId: executionThreadId });
      onOpenRoom(goalGroupId);
    } else if (primary) {
      openBotThread(dispatch, primary, executionThreadId, showThreads);
    }
    onClose();
  };

  const invoke = async (path: string, method = "POST", body?: unknown) => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const runRoutineNow = () => {
    if (!routine || working || runNowPending.current) return;
    runNowPending.current = true;
    setStarting(true);
    setSubmittedRun(null);
    setWorking(true);
    setError("");
    // Stays pending through the store's settings flush and the POST, so a double-click cannot create two runs.
    dispatch({
      type: "runRoutine",
      routineId: routine.id,
      // Prefer later SSE records over this response, which may already be stale.
      onStarted: setSubmittedRun,
      onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      onSettled: () => {
        runNowPending.current = false;
        setStarting(false);
        setWorking(false);
      },
    });
  };

  const joinRoom = async () => {
    if (!call) return;
    setWorking(true);
    setError("");
    try {
      const { group: created } = await api(`/api/calendar-calls/${call.id}/room`, { method: "POST" });
      dispatch({ type: "groupPatched", group: created });
      onOpenRoom(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const deleteEvent = async () => {
    if (!window.confirm(`Delete “${title}”?`)) return;
    if (call) {
      await api(`/api/calendar-calls/${call.id}`, { method: "DELETE" });
      onCallChanged(call.id);
    } else if (routine) {
      dispatch({ type: "deleteRoutine", routineId: routine.id });
    }
    onClose();
  };

  const routineId = routine?.id ?? run?.routineId;
  const recentRuns = routineId
    ? state.routineRuns.filter((candidate) => candidate.routineId === routineId)
      .sort((left, right) => routineRunTime(right) - routineRunTime(left))
      .slice(0, 3)
    : [];
  const runOn = run?.runOn ?? routine?.runOn;
  const runsOn = routineRunsOn({ roomGoal: isRoomGoal, runOn, computer: primary?.computer, cloudHome: state.config?.cloudHome === true });
  const resultsOwner = resultsThreadId
    ? [...state.bots, ...state.groups].find((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId))
    : undefined;
  const resultsTitle = !resultsThreadId
    ? t("routines.results.main")
    : resultsOwner?.tasks?.find((task) => task.threadId === resultsThreadId)?.title ?? resultsOwner?.name ?? t("routines.results.missing");

  return (
    <aside aria-label={t("routines.drawer.label")} className="flex h-full w-[min(310px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-start gap-3 border-b border-hairline/40 px-4 py-3.5">
        {isCall
          ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text"><Video size={16} /></span>
          : isRoomGoal
            ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text"><UsersRound size={16} /></span>
            : primary && <BotAvatar bot={primary} state={run ? statusState(run.status) : routine?.enabled === false ? "sleeping" : "idle"} size={36} animated={false} />}
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] font-semibold leading-snug text-ink">{title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {routine && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", routine.enabled ? "bg-success/15 text-success" : "bg-inset text-ink-secondary")}>{routineScheduleState(routine)}</span>}
            <span className="text-[11px] text-ink-secondary">{niceDate(item.at)} · {niceTime(item.at)}{isCall ? ` – ${niceTime(item.at + item.durationMinutes * 60_000)}` : ""}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.drawer.close")}><X size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {run && <div role="status" aria-live="polite" className="rounded-xl border border-hairline/40 bg-inset p-3"><div className="flex items-center gap-2 text-[12px] font-medium text-ink">{run.status === "running" && <Loader2 size={13} className="animate-spin text-accent" />}{routineRunLabel(run)}</div>{run.output && <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-secondary">{run.output}</div>}{run.error && <div className="mt-2 text-[12px] text-danger">{run.error}</div>}</div>}
        {run?.attention && <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning"><CircleAlert size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 whitespace-pre-wrap text-[12px] leading-relaxed">{run.attention}</div></div>}
        {run?.status === "waiting" && !run.attention && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] text-warning">This run is waiting. Open its execution thread for more context.</div>}

        <DrawerField label={isCall ? t("routines.drawer.guests") : isRoomGoal ? t("routines.drawer.lead") : t("routines.drawer.bot")}>
          <div className="flex flex-wrap gap-1.5">
            {invited.map((bot) => <div key={bot.id} className="flex items-center gap-1.5 rounded-full border border-hairline/50 bg-inset py-0.5 pl-0.5 pr-2.5"><BotAvatar bot={bot} state="idle" size={22} animated={false} /><span className="text-[12px] text-ink">{bot.name}</span></div>)}
            {invited.length === 0 && <span className="text-[13px] text-ink-secondary">{t("routines.unavailableBot")}</span>}
          </div>
        </DrawerField>
        {isRoomGoal && goalGroupId && <DrawerField label={t("routines.drawer.group")}><div className="text-[13px] text-ink">{goalGroup?.name ?? "Group unavailable"}</div></DrawerField>}
        {(routine || call) && (
          <DrawerField label={t("routines.drawer.schedule")}>
            <div className="text-[13px] text-ink">{scheduleLabel((routine ?? call)!.schedule)}</div>
            {routine?.schedule.type === "cron" && <div className="mt-2"><CronSchedulePreview schedule={routine.schedule} paused={!routine.enabled} /></div>}
          </DrawerField>
        )}
        {description && <DrawerField label={isCall ? t("routines.drawer.agenda") : t("routines.drawer.what")}><div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{description}</div></DrawerField>}
        {!isCall && (
          <DrawerField label={t("routines.drawer.runsOn")}>
            <div className="flex items-start gap-2 text-[13px] text-ink">{runOn === "cloud" ? <Cloud size={14} className="mt-0.5 shrink-0 text-ink-secondary" /> : <Laptop size={14} className="mt-0.5 shrink-0 text-ink-secondary" />}<span>{runsOn.label}</span></div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">{runsOn.hint}</div>
          </DrawerField>
        )}
        {!isCall && !isRoomGoal && <DrawerField label={t("routines.results.label")}><div className="text-[13px] text-ink">{resultsTitle}</div></DrawerField>}
        {attachments.length > 0 && <DrawerField label="Attachments"><AttachmentChips attachments={attachments} />{call && <div className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">{call.botIds.length > 1 ? "These references will be shared in the group when the event starts." : "These references stay with the event and are available when you join the group."}</div>}</DrawerField>}
        {advanced && !isCall && <DrawerField label={t("routines.drawer.runLimit")}><div className="text-[13px] text-ink">{safetyLimit == null ? "No time limit" : `Stops if still running after ${durationLabel(safetyLimit)}`}</div></DrawerField>}
        {!isCall && (
          <DrawerField label={t("routines.logs")} action={routine && <button type="button" onClick={() => { dispatch({ type: "showRoutines", section: "logs", routineId: routine.id, botId: routine.botId }); onClose(); }} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-accent-text hover:bg-raised"><FileText size={11} />{t("routines.drawer.allRuns")}</button>}>
            {recentRuns.length === 0
              ? <div className="text-[12px] text-ink-secondary">{t("routines.drawer.noRuns")}</div>
              : <div className="space-y-1">{recentRuns.map((recent) => <RecentRunRow key={recent.id} run={recent} current={recent.id === run?.id} onOpen={() => onOpenRun?.(recent)} />)}</div>}
          </DrawerField>
        )}
        {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </div>

      <div className="space-y-2 border-t border-hairline/40 px-4 py-3">
        {routine && (
          <div className="flex items-center gap-2">
            <button onClick={runRoutineNow} disabled={working} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50">{starting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{starting ? t("routines.starting") : t("routines.runNow")}</button>
            <button disabled={working} onClick={() => void invoke(`/api/routines/${routine.id}`, "PATCH", { enabled: !routine.enabled })} title={routine.enabled ? "Pause routine" : "Resume routine"} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40">{routine.enabled ? <Pause size={13} /> : <Play size={13} />}{routine.enabled ? t("routines.pause") : t("routines.resume")}</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {roomId && <button onClick={() => onOpenRoom(roomId)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110"><ExternalLink size={13} />Join group</button>}
          {call && call.botIds.length > 1 && <button onClick={joinRoom} disabled={working} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50"><ExternalLink size={13} />Join group</button>}
          {isRoomGoal && goalGroup && !executionThreadId && <button onClick={() => { onOpenRoom(goalGroup.id); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />Open group</button>}
          {canOpenExecution && <button onClick={openRunTask} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />{isRoomGoal && goalGroupId ? "Open group thread" : "Open thread"}</button>}
          {canOpenResults && openResultsId && <button type="button" onClick={() => { openNotificationTarget(dispatch, { botId: botIds[0], threadId: openResultsId }, state, showThreads); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><ExternalLink size={13} />{t("routines.results.open")}</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} disabled={working} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"><X size={13} />Cancel run</button>}
          <div className="ml-auto flex items-center gap-1">
            {(routine || call) && <button onClick={onEdit} className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised">{t("routines.edit")}</button>}
            {(routine || call) && <button onClick={() => void deleteEvent()} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title={t("routines.delete")} aria-label={t("routines.delete")}><Trash2 size={14} /></button>}
          </div>
        </div>
      </div>
    </aside>
  );
}

function DrawerField({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function runDurationLabel(run: RoutineRun): string | null {
  if (run.startedAt == null || run.finishedAt == null || run.finishedAt < run.startedAt) return null;
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return durationLabel(Math.round(seconds / 60));
}

function RecentRunRow({ run, current, onOpen }: { run: RoutineRun; current: boolean; onOpen: () => void }) {
  const at = run.startedAt ?? run.scheduledFor;
  const duration = runDurationLabel(run);
  const ok = run.status === "completed" && (!run.goalStatus || run.goalStatus === "completed");
  const problem = isRoutineProblemRun(run) || run.goalStatus === "failed" || run.goalStatus === "blocked";
  const active = ["queued", "running", "waiting"].includes(run.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("routines.openRun", { name: run.routineName, status: routineRunLabel(run) })}
      aria-current={current || undefined}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised", current && "bg-raised")}
    >
      {ok
        ? <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden="true" />
        : problem
          ? <XCircle size={14} className="shrink-0 text-danger" aria-hidden="true" />
          : active
            ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
            : <CircleAlert size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{niceTime(at)}{duration ? ` · ${duration}` : ""}</span>
    </button>
  );
}

export function PausedList({
  routines,
  bots,
  groups,
  onClose,
  onEdit,
  onOpenRoom,
}: {
  routines: Routine[];
  bots: Bot[];
  groups: Group[];
  onClose: () => void;
  onEdit: (routine: Routine) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Paused routines" tabIndex={-1} className="w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[16px] font-semibold text-ink">Paused routines</div><div className="mt-0.5 text-[12px] text-ink-secondary">History is kept; no new tasks will run.</div></div><button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised" aria-label={t("routines.paused.close")}><X size={17} /></button></div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto p-3">
          {routines.map((routine) => {
            const bot = bots.find((candidate) => candidate.id === routine.botId);
            const room = routine.target === "room-goal"
              ? groups.find((candidate) => candidate.id === routine.groupId)
              : undefined;
            return (
              <div key={routine.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-raised/60">
                {room ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent"><UsersRound size={17} /></span> : bot && <BotAvatar bot={bot} state="sleeping" size={36} animated={false} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-ink">{routine.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-secondary">{room ? `${t("routines.editor.teamGoal")} · ${room.name} · ` : ""}{scheduleLabel(routine.schedule)}</div>
                </div>
                {room && <button onClick={() => { onOpenRoom(room.id); onClose(); }} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Group</button>}
                <button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11px] font-medium text-accent">Resume</button>
                <button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Edit</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RoutineEditor({
  routine,
  bots,
  lockedBotId, initialBotId,
  defaultRunOn, plain,
  onClose,
}: {
  routine?: Routine;
  bots: Bot[];
  lockedBotId?: string; initialBotId?: string;
  defaultRunOn?: RoutineRunOn; plain?: boolean;
  onClose: () => void;
}) {
  const at = routine?.schedule.type === "once"
    ? routine.schedule.at
    : routine?.schedule.type === "daily"
      ? atLocalTime(Date.now(), routine.schedule.time)
      : routine?.schedule.type === "interval"
        ? routine.schedule.anchorAt
      : routine?.schedule.type === "cron"
        ? routine.nextRunAt ?? nextHour()
      : nextHour();
  return <EventEditor seed={{ kind: "routine", at, durationMinutes: routine?.durationMinutes ?? 30, botIds: lockedBotId ? [lockedBotId] : routine ? [routine.botId] : initialBotId ? [initialBotId] : bots.length === 1 ? [bots[0]!.id] : [], routine }} bots={bots} lockedBotId={lockedBotId} defaultRunOn={defaultRunOn} plain={plain} onClose={onClose} onSavedCall={() => {}} />;
}
