import { boatCapableEngine } from "@/lib/remote-desktop";
import { useRef, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  FileText,
  Laptop,
  Loader2,
  Paperclip,
  Repeat2,
  Target,
  UserRoundPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { pathForFile } from "@/components/ComposerAttachments";
import { ResultsDestination } from "@/components/routines/ResultsDestination";
import { CronScheduleFields } from "@/components/routines/CronScheduleFields";
import { cronChoiceFor, cronDraftFor, cronEditorValue, isCronChoice, type CronChoice } from "@/components/routines/cron-editor";
import { useAdvancedMode } from "@/lib/interface-mode";
import { activeLocale, t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { CalendarCall, CalendarCallAttachment, CalendarCallInput } from "@/lib/calendar-calls";
import { isDone } from "@/lib/automations";
import { cn } from "@/lib/cn";
import {
  imageAttachmentFromFile,
  intakeFiles,
} from "@/lib/composer-attachments";
import {
  addDays,
  atLocalTime,
  CALENDAR_SLOT_MINUTES,
  fromLocalDateAndTime,
  intervalAnchorForSave,
  nextIntervalForSave,
  startOfDay,
  toLocalDateInput,
  toLocalTimeInput,
} from "@/lib/routine-calendar";
import { LimitResetFields, type LimitResetChoice } from "./routines/LimitResetFields";
import { DAY_NAMES, durationLabel, niceTime } from "@/lib/schedule-label";
import { Select } from "./Select";
import {
  type RoutineContextAttachment,
  type RoutineInput,
  type RoutineRunOn,
  type RoutineSchedule,
  type RoutineScheduleInput,
  type RoutineTarget,
} from "@/lib/routines";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { RoutineScheduleNote } from "./RoutineScheduleNote";
import { AttachmentChips, BotPicker, toContextAttachments } from "./routine-calendar-editor-widgets";
import type { EventKind, EventSeed } from "./routine-calendar-types";

const DAY_CHIP_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const INTERVAL_PRESETS = [5, 10, 15, 30, 60];
const EVENT_DURATION_OPTIONS = Array.from({ length: 240 / CALENDAR_SLOT_MINUTES }, (_, index) => (index + 1) * CALENDAR_SLOT_MINUTES);

type CalendarRecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom";
type RecurrenceChoice = CalendarRecurrenceChoice | "interval" | "limit_reset" | CronChoice;
type IntervalDayChoice = "every-day" | "weekdays" | "custom";
type IntervalWindowChoice = "all-day" | "custom";
type IntervalEndChoice = "never" | "on-date";

/** No group is a goal in one bot's own chat, which any active bot can lead. */
function activeRoomMembers(group: Group | undefined, bots: Bot[]): Bot[] {
  if (!group) return bots.filter((bot) => !bot.hidden);
  return group.memberIds.flatMap((id) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot && !bot.hidden ? [bot] : [];
  });
}

function roomCanRunGoal(group: Group): boolean {
  if (group.dm) return false;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(group, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(group, "setupSkippedAt");
  return !hasSetupMarker ||
    group.setupCompletedAt != null ||
    group.setupSkippedAt != null ||
    (group.messages?.length ?? 0) > 0;
}

function preferredRoomLead(group: Group | undefined, bots: Bot[], preferredId?: string): Bot | undefined {
  const members = activeRoomMembers(group, bots);
  const explicitLeadId = group?.defaultResponder.kind === "member" ? group.defaultResponder.botId : undefined;
  return members.find((bot) => bot.id === preferredId)
    ?? members.find((bot) => bot.id === explicitLeadId)
    ?? members.find((bot) => bot.chiefOfStaff)
    ?? members[0];
}

function sameDays(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return Boolean(left && left.length === right.length && left.every((day, index) => day === right[index]));
}

function intervalDayChoice(schedule: RoutineSchedule | CalendarCall["schedule"]): IntervalDayChoice {
  if (schedule.type !== "interval" || !schedule.weekdays || schedule.weekdays.length === 7) return "every-day";
  return sameDays(schedule.weekdays, WEEKDAYS) ? "weekdays" : "custom";
}

function endOfLocalDate(dateInput: string): number {
  const date = new Date(`${dateInput}T00:00`);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}
function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.type === "limit_reset") return "limit_reset";
  if (schedule.type === "interval") return "interval";
  if (schedule.type === "cron") return cronChoiceFor(schedule);
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

function makeCalendarSchedule(choice: CalendarRecurrenceChoice, at: number, weekdays: number[]): CalendarCall["schedule"] {
  if (choice === "none") return { type: "once", at };
  const selected = choice === "daily"
    ? ALL_DAYS
    : choice === "weekdays"
      ? WEEKDAYS
      : choice === "weekly"
        ? [new Date(at).getDay()]
        : weekdays;
  return { type: "daily", time: toLocalTimeInput(at), weekdays: [...selected].sort() };
}

function makeRoutineSchedule(
  choice: Exclude<RecurrenceChoice, CronChoice | "limit_reset">,
  at: number,
  weekdays: number[],
  everyMinutes: number,
  interval: {
    anchorAt: number;
    weekdays: number[] | null;
    window: { start: string; end: string } | null;
    endsAt: number | null;
  },
): RoutineScheduleInput {
  if (choice === "interval") return { type: "interval", everyMinutes, ...interval };
  return makeCalendarSchedule(choice, at, weekdays);
}

export function EventEditor({
  seed,
  bots,
  lockedBotId,
  defaultRunOn,
  routinesOnly = false,
  plain = false, onClose,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  routinesOnly?: boolean; plain?: boolean;
  onClose: () => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { state, dispatch } = useStore();
  const existingRoutine = seed.routine;
  const { request: editorRequest } = useBotEditor();
  const existingCall = seed.call;
  const [kind, setKind] = useState<EventKind>(routinesOnly ? "routine" : seed.kind);
  const [editorOpenedAt] = useState(() => Date.now());
  const [name, setName] = useState(existingRoutine?.name ?? existingCall?.name ?? seed.name ?? "");
  const [description, setDescription] = useState(existingRoutine?.prompt ?? existingCall?.description ?? seed.description ?? "");
  const initialAt = existingRoutine?.schedule.type === "once"
    ? existingRoutine.schedule.at
    : existingRoutine?.schedule.type === "daily"
      ? atLocalTime(seed.at, existingRoutine.schedule.time)
      : existingRoutine?.schedule.type === "interval"
        ? existingRoutine.schedule.anchorAt
      : existingCall?.schedule.type === "once"
        ? existingCall.schedule.at
        : existingCall?.schedule.type === "daily"
          ? atLocalTime(seed.at, existingCall.schedule.time)
          : seed.at;
  const schedule = existingRoutine?.schedule ?? existingCall?.schedule ?? { type: "once" as const, at: initialAt };
  const [date, setDate] = useState(toLocalDateInput(initialAt));
  const [startTime, setStartTime] = useState(toLocalTimeInput(initialAt));
  const [durationMinutes, setDurationMinutes] = useState(existingRoutine?.durationMinutes ?? existingCall?.durationMinutes ?? seed.durationMinutes);
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(
    existingRoutine?.timeoutMinutes ?? null,
  );
  const [intervalTimeoutDefaultApplied, setIntervalTimeoutDefaultApplied] = useState(Boolean(existingRoutine));
  const [overlap, setOverlap] = useState<"skip" | "queue">(existingRoutine?.overlap ?? "skip");
  const [continuity, setContinuity] = useState(Boolean(existingRoutine?.continuity));
  const [runOnStartup, setRunOnStartup] = useState(Boolean(existingRoutine?.runOnStartup));
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>(seed.limitReset ? "limit_reset" : recurrenceFor(schedule, initialAt));
  const [limitReset, setLimitReset] = useState<LimitResetChoice>(schedule.type === "limit_reset" ? schedule : { engine: seed.limitReset?.engine ?? "", repeat: "once" });
  const [cronDraft, setCronDraft] = useState(() => cronDraftFor(schedule.type === "cron" ? schedule : undefined, initialAt));
  const [cronChanged, setCronChanged] = useState(false);
  const [weekdays, setWeekdays] = useState(schedule.type === "daily" ? schedule.weekdays : [new Date(initialAt).getDay()]);
  const [intervalMinutes, setIntervalMinutes] = useState(schedule.type === "interval" ? schedule.everyMinutes : 15);
  const [intervalDays, setIntervalDays] = useState<IntervalDayChoice>(() => intervalDayChoice(schedule));
  const [intervalWeekdays, setIntervalWeekdays] = useState(() => schedule.type === "interval" && schedule.weekdays?.length
    ? schedule.weekdays
    : [...ALL_DAYS]);
  const [intervalWindow, setIntervalWindow] = useState<IntervalWindowChoice>(schedule.type === "interval" && schedule.window ? "custom" : "all-day");
  const [intervalWindowStart, setIntervalWindowStart] = useState(schedule.type === "interval" ? schedule.window?.start ?? "09:00" : "09:00");
  const [intervalWindowEnd, setIntervalWindowEnd] = useState(schedule.type === "interval" ? schedule.window?.end ?? "17:00" : "17:00");
  const [intervalEnd, setIntervalEnd] = useState<IntervalEndChoice>(schedule.type === "interval" && schedule.endsAt != null ? "on-date" : "never");
  const [intervalEndDate, setIntervalEndDate] = useState(() => schedule.type === "interval" && schedule.endsAt != null
    ? toLocalDateInput(schedule.endsAt)
    : toLocalDateInput(addDays(startOfDay(Math.max(Date.now(), initialAt)), 7)));
  const [botIds, setBotIds] = useState(lockedBotId ? [lockedBotId] : existingRoutine ? [existingRoutine.botId] : existingCall?.botIds ?? seed.botIds);
  const [resultsThreadId, setResultsThreadId] = useState<string | null | undefined>((existingRoutine ? existingRoutine.resultsThreadId : seed.resultsThreadId) ?? null);
  const selectBots = (ids: string[]) => {
    if (ids[0] !== botIds[0]) setResultsThreadId(null);
    setBotIds(ids);
  };
  const [routineTarget, setRoutineTarget] = useState<RoutineTarget>(existingRoutine?.target ?? "bot");
  const [groupId, setGroupId] = useState(existingRoutine?.groupId ?? "");
  const [runOn, setRunOn] = useState<RoutineRunOn>(existingRoutine?.runOn ?? defaultRunOn ?? "maus");
  const [attachments, setAttachments] = useState<Array<RoutineContextAttachment | CalendarCallAttachment>>(
    existingRoutine?.target === "room-goal" ? [] : existingRoutine?.attachments ?? existingCall?.attachments ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [attachmentPendingCount, setAttachmentPendingCount] = useState(0);
  const attachmentPending = attachmentPendingCount > 0;
  const fileInput = useRef<HTMLInputElement>(null);
  const cloudReady = Boolean(state.config?.box.configured && botIds.length > 0 && botIds.every(id => boatCapableEngine(state.instances, bots.find(bot => bot.id === id)?.modelSelection.instanceId)?.snapshot.state === "available"));
  const rooms = state.groups.filter(roomCanRunGoal);
  const selectedRoom = rooms.find((group) => group.id === groupId);
  const roomMembers = selectedRoom ? activeRoomMembers(selectedRoom, state.bots) : bots;
  const isRoomGoal = kind === "routine" && routineTarget === "room-goal";
  const cloudHome = state.config?.cloudHome === true;
  const at = fromLocalDateAndTime(date, startTime, existingRoutine || existingCall ? initialAt : undefined);
  const endAt = at + durationMinutes * 60_000;
  const selectedBots = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const dialogRef = useRef<HTMLDivElement>(null);
  const intervalInvalid = recurrence === "interval"
    && (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1_440);
  const intervalDaysInvalid = recurrence === "interval" && intervalDays === "custom" && intervalWeekdays.length === 0;
  const intervalWindowMinutes = fromLocalDateAndTime("2000-01-01", intervalWindowEnd)
    - fromLocalDateAndTime("2000-01-01", intervalWindowStart);
  const intervalWindowInvalid = recurrence === "interval"
    && intervalWindow === "custom"
    && (!intervalWindowStart
      || !intervalWindowEnd
      || !Number.isFinite(intervalWindowMinutes)
      || intervalWindowMinutes < intervalMinutes * 60_000);
  const existingIntervalSchedule = existingRoutine?.schedule.type === "interval"
    ? existingRoutine.schedule
    : undefined;
  const intervalEndMinimumAt = nextIntervalForSave(
    editorOpenedAt,
    Math.max(5, intervalMinutes || 5),
    existingIntervalSchedule,
  );
  const intervalEndsAt = intervalEnd === "on-date" ? endOfLocalDate(intervalEndDate) : null;
  const intervalEndInvalid = recurrence === "interval"
    && intervalEnd === "on-date"
    && (intervalEndsAt == null || !Number.isSafeInteger(intervalEndsAt) || intervalEndsAt < intervalEndMinimumAt);
  const selectedIntervalWeekdays = intervalDays === "every-day"
    ? undefined
    : intervalDays === "weekdays"
      ? WEEKDAYS
      : intervalWeekdays;
  const selectedIntervalWindow = intervalWindow === "custom"
    ? { start: intervalWindowStart, end: intervalWindowEnd }
    : undefined;
  const cron = isCronChoice(recurrence)
    ? cronEditorValue(recurrence, cronDraft, editorOpenedAt, !cronChanged && schedule.type === "cron" ? schedule : undefined)
    : null;

  const selectRecurrence = (choice: RecurrenceChoice) => {
    if (choice === "interval" && !intervalTimeoutDefaultApplied) {
      setTimeoutMinutes((current) => current ?? 30);
      setIntervalTimeoutDefaultApplied(true);
    }
    if (isCronChoice(choice)) {
      if (choice === "cron" && cron?.schedule) setCronDraft((draft) => ({ ...draft, expression: cron.schedule!.expression }));
      setCronChanged(true);
    }
    setRecurrence(choice);
  };

  const selectIntervalDays = (choice: IntervalDayChoice) => {
    if (choice === "custom" && intervalDays !== "custom") {
      setIntervalWeekdays(intervalDays === "weekdays" ? [...WEEKDAYS] : [...ALL_DAYS]);
    }
    setIntervalDays(choice);
  };

  const selectRoutineTarget = (target: RoutineTarget) => {
    setRoutineTarget(target);
    if (target === "bot") {
      setGroupId("");
      return;
    }
    setRunOn("maus");
    setAttachments([]);
    setAttachmentNotice("");
    const room = selectedRoom ?? rooms[0];
    setGroupId(room?.id ?? "");
    const lead = preferredRoomLead(room, state.bots, botIds[0]);
    selectBots(lead ? [lead.id] : []);
  };

  const selectRoom = (nextGroupId: string) => {
    const room = rooms.find((candidate) => candidate.id === nextGroupId);
    setGroupId(nextGroupId);
    const lead = preferredRoomLead(room, state.bots, botIds[0]);
    selectBots(lead ? [lead.id] : []);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length || isRoomGoal) return;
    setAttachmentPendingCount((count) => count + 1);
    try {
      const result = await intakeFiles(Array.from(files), {
        allowImages: true,
        getPath: pathForFile,
        uploadImage: imageAttachmentFromFile,
      });
      const added = toContextAttachments(result.attachments);
      if (added.length) {
        setAttachments((current) => [...current, ...added].slice(0, 20));
        if (runOn === "cloud") setRunOn("maus");
      }
      if (result.notice) setAttachmentNotice(result.notice);
    } finally {
      setAttachmentPendingCount((count) => Math.max(0, count - 1));
    }
  };

  const save = async () => {
    if (attachmentPending) return;
    setSaving(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const savedAt = Date.now();
        const intervalAnchorAt = intervalAnchorForSave(savedAt, intervalMinutes, existingIntervalSchedule);
        if (recurrence === "interval" && intervalEndsAt != null && intervalEndsAt < nextIntervalForSave(savedAt, intervalMinutes, existingIntervalSchedule)) {
          throw new Error("Choose an end date after the first run.");
        }
        const limitEngine = limitReset.engine || bots.find((bot) => bot.id === (lockedBotId ?? botIds[0]))?.modelSelection?.instanceId || "";
        const nextSchedule = recurrence === "limit_reset" ? { type: "limit_reset" as const, engine: limitEngine, repeat: limitReset.repeat } : isCronChoice(recurrence) ? cron?.schedule : makeRoutineSchedule(recurrence, at, weekdays, intervalMinutes, {
          anchorAt: intervalAnchorAt,
          weekdays: selectedIntervalWeekdays ? [...selectedIntervalWeekdays].sort() : null,
          window: selectedIntervalWindow ?? null,
          endsAt: intervalEndsAt,
        });
        if (!nextSchedule) throw new Error(cron?.error || "Choose a valid schedule.");
        const input: RoutineInput = {
          name,
          prompt: description,
          target: routineTarget,
          botId: lockedBotId ?? botIds[0] ?? "",
          groupId: routineTarget === "room-goal" && groupId ? groupId : null,
          runOn: routineTarget === "room-goal" ? "maus" : runOn,
          enabled: existingRoutine && (existingRoutine.enabled || !isDone(existingRoutine, savedAt)) ? undefined : true,
          schedule: nextSchedule,
          durationMinutes,
          timeoutMinutes,
          overlap,
          continuity: routineTarget === "bot" && recurrence !== "none" && continuity,
          runOnStartup: recurrence !== "none" && runOnStartup,
          attachments: routineTarget === "room-goal" ? [] : attachments as RoutineContextAttachment[],
          ...(routineTarget === "bot" ? { resultsThreadId } : {}),
        };
        const response = await editorRequest(existingRoutine ? `/api/routines/${existingRoutine.id}` : "/api/routines", { method: existingRoutine ? "PATCH" : "POST", body: JSON.stringify(input) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        if (recurrence === "interval" || recurrence === "limit_reset" || isCronChoice(recurrence)) throw new Error("Choose a supported call schedule.");
        const nextSchedule = makeCalendarSchedule(recurrence, at, weekdays);
        const input: CalendarCallInput = {
          name,
          description,
          botIds,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as CalendarCallAttachment[],
        };
        const response = await api(existingCall ? `/api/calendar-calls/${existingCall.id}` : "/api/calendar-calls", {
          method: existingCall ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const valid = Boolean(
    name.trim()
    && (kind === "call" || description.trim())
    && (!lockedBotId || botIds[0] === lockedBotId)
    && (kind === "call"
      ? botIds.length > 0
      : routineTarget === "room-goal"
        ? botIds[0] && roomMembers.some((bot) => bot.id === botIds[0])
        : botIds.length > 0)
    && !intervalInvalid
    && !intervalDaysInvalid
    && !intervalWindowInvalid
    && !intervalEndInvalid
    && !cron?.error,
  );
  const canSwitchKind = !routinesOnly && !existingRoutine && !existingCall && !lockedBotId;
  const advanced = useAdvancedMode() && !plain;
  const [moreOpen, setMoreOpen] = useState(() => !(["none", "daily", "weekdays", "weekly"] as RecurrenceChoice[]).includes(recurrence)
    || routineTarget === "room-goal"
    || attachments.length > 0
    || runOn === "cloud"
    || timeoutMinutes != null
    || runOnStartup
    || overlap === "queue");

  useModalDialog(dialogRef, onClose);

  const kindSwitchControl = canSwitchKind && (
            <div className={cn(advanced && "ml-10", "inline-flex rounded-lg bg-inset p-1")}>
              <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-md px-4 py-1.5 text-[13px] font-medium", kind === "routine" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>{t("routines.kind.routine")}</button>
              <button type="button" onClick={() => { setKind("call"); if (recurrence === "interval" || recurrence === "limit_reset" || isCronChoice(recurrence)) setRecurrence("none"); }} className={cn("rounded-md px-4 py-1.5 text-[13px] font-medium", kind === "call" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>{t("routines.kind.call")}</button>
            </div>
          );
  const routineTypeControl = kind === "routine" && !lockedBotId && (
            <div className={cn(advanced && "ml-10")}>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{t("routines.editor.type")}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => selectRoutineTarget("bot")}
                  className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", routineTarget === "bot" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}
                >
                  <UserRoundPlus size={17} className={cn("mt-0.5 shrink-0", routineTarget === "bot" ? "text-accent" : "text-ink-secondary")} />
                  <span><span className="block text-[13px] font-medium text-ink">{t("routines.editor.botTask")}</span><span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("routines.editor.botTaskHelp")}</span></span>
                </button>
                <button
                  type="button"
                  onClick={() => selectRoutineTarget("room-goal")}
                  className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", routineTarget === "room-goal" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}
                >
                  <Target size={17} className={cn("mt-0.5 shrink-0", routineTarget === "room-goal" ? "text-accent" : "text-ink-secondary")} />
                  <span><span className="block text-[13px] font-medium text-ink">{t("routines.editor.teamGoal")}</span><span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("routines.editor.teamGoalHelp")}</span></span>
                </button>
              </div>
            </div>
          );
  const whenControls = recurrence !== "interval" && recurrence !== "limit_reset" && !isCronChoice(recurrence) && (
                <div className="flex flex-wrap items-center gap-2">
                  {kind === "routine" && recurrence === "none" && <span className="text-[12px] font-medium text-ink-secondary">{t("routines.schedule.starts")}</span>}
                  {kind === "routine" && recurrence === "weekly" && <span className="text-[12px] font-medium text-ink-secondary">{t("routines.schedule.on")}</span>}
                  {(kind === "call" || recurrence === "none" || recurrence === "weekly") && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />}
                  <input type="time" step={CALENDAR_SLOT_MINUTES * 60} value={startTime} onChange={(event) => setStartTime(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                  {kind === "call" && <>
                    <span className="text-[12px] text-ink-secondary">to</span>
                    <span className="rounded-lg border border-hairline/40 bg-inset/60 px-3 py-2 text-[13px] text-ink">{niceTime(endAt)}</span>
                    <Select aria-label="Call duration" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}>
                      {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                    </Select>
                  </>}
                </div>
              );
  const repeatSelect = (
              <div className="flex flex-wrap items-center gap-2">
                <Repeat2 size={14} className="text-ink-secondary" />
                <Select aria-label={t("routines.editor.repeat")} value={recurrence} onChange={(event) => selectRecurrence(event.target.value as RecurrenceChoice)}>
                  <option value="none">{t("routines.repeat.doesNotRepeat")}</option>
                  {kind === "routine" && <option value="interval">{t("routines.repeat.everyXMinutes")}</option>}
                  <option value="daily">{t("routines.repeat.daily")}</option>
                  <option value="weekdays">{t("routines.repeat.weekdaysLong")}</option>
                  <option value="weekly">{t("routines.repeat.weeklyOn", { day: new Date(at).toLocaleDateString(activeLocale(), { weekday: "long" }) })}</option>
                  <option value="custom">{t("routines.repeat.customWeekdays")}</option>
                  {kind === "routine" && <><option value="monthly">{t("routines.repeat.monthly")}</option><option value="yearly">{t("routines.repeat.yearly")}</option><option value="cron">{t("routines.repeat.cron")}</option></>}
                  {kind === "routine" && <option value="limit_reset">{t("routines.limitReset.option")}</option>}
                </Select>
              </div>
  );
  const scheduleNote = kind === "routine" && <RoutineScheduleNote />;
  const repeatDetails = (
    <>
              {recurrence === "limit_reset" && kind === "routine" && <LimitResetFields value={limitReset} botEngine={bots.find((bot) => bot.id === (lockedBotId ?? botIds[0]))?.modelSelection?.instanceId} onChange={setLimitReset} />}
              {isCronChoice(recurrence) && kind === "routine" && cron && <CronScheduleFields choice={recurrence} value={cronDraft} onChange={(draft) => { setCronDraft(draft); setCronChanged(true); }} runs={cron.runs} error={cron.error} />}
              {recurrence === "custom" && (
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((label, day) => <button key={label} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-8 rounded-full text-[10px] font-semibold", weekdays.includes(day) ? "bg-accent text-white" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}>{label[0]}</button>)}
                </div>
              )}
              {recurrence === "interval" && kind === "routine" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                    <span className="font-medium">{t("routines.interval.runsEvery")}</span>
                    <Select
                      value={INTERVAL_PRESETS.includes(intervalMinutes) ? String(intervalMinutes) : "custom"}
                      onChange={(event) => setIntervalMinutes(event.target.value === "custom" ? 0 : Number(event.target.value))}
                      aria-label={t("routines.interval.runsEvery")}
                    >
                      {INTERVAL_PRESETS.map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}
                      <option value="custom">{t("routines.interval.custom")}</option>
                    </Select>
                    {!INTERVAL_PRESETS.includes(intervalMinutes) && (
                      <input
                        type="number"
                        min={5}
                        max={1_440}
                        step={1}
                        value={intervalMinutes || ""}
                        onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                        aria-label={t("routines.interval.custom")}
                        aria-invalid={intervalInvalid}
                        aria-describedby={intervalInvalid ? "routine-interval-error" : "routine-interval-help"}
                        autoFocus
                        className={cn("w-20 rounded-lg border bg-inset px-3 py-2 text-[13px] tabular-nums text-ink outline-none focus:border-accent", intervalInvalid ? "border-danger/70" : "border-hairline/50")}
                      />
                    )}
                    <span>{t("routines.interval.minutes")}</span>
                  </div>

                  <div className="grid items-center gap-2 text-[13px] text-ink sm:flex sm:flex-wrap">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">{t("routines.schedule.on")}</span>
                      <Select
                        value={intervalDays}
                        onChange={(event) => selectIntervalDays(event.target.value as IntervalDayChoice)}
                        aria-label={t("routines.schedule.on")}
                        aria-invalid={intervalDaysInvalid}
                        aria-describedby={intervalDaysInvalid ? "routine-interval-days-error" : undefined}
                      >
                        <option value="every-day">{t("routines.interval.everyDay")}</option>
                        <option value="weekdays">{t("routines.interval.weekdays")}</option>
                        <option value="custom">{t("routines.interval.custom")}</option>
                      </Select>
                    </span>
                    <span aria-hidden="true" className="hidden text-ink-secondary sm:inline">·</span>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">{t("routines.interval.during")}</span>
                      <Select
                        value={intervalWindow}
                        onChange={(event) => setIntervalWindow(event.target.value as IntervalWindowChoice)}
                        aria-label={t("routines.interval.during")}
                        aria-invalid={intervalWindowInvalid}
                        aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined}
                      >
                        <option value="all-day">{t("routines.interval.allDay")}</option>
                        <option value="custom">{t("routines.interval.customHours")}</option>
                      </Select>
                    </span>
                    <span aria-hidden="true" className="hidden text-ink-secondary sm:inline">·</span>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">{t("routines.interval.ends")}</span>
                      <Select
                        value={intervalEnd}
                        onChange={(event) => setIntervalEnd(event.target.value as IntervalEndChoice)}
                        aria-label={t("routines.interval.ends")}
                        aria-invalid={intervalEndInvalid}
                        aria-describedby={intervalEndInvalid ? "routine-interval-end-error" : undefined}
                      >
                        <option value="never">{t("routines.interval.never")}</option>
                        <option value="on-date">{t("routines.interval.onDate")}</option>
                      </Select>
                    </span>
                  </div>

                  {intervalDays === "custom" && (
                    <div>
                      <div className="mb-2 text-[11px] font-medium text-ink-secondary">{t("routines.interval.chooseDays")}</div>
                      <div
                        role="group"
                        aria-label={t("routines.interval.chooseDays")}
                        aria-invalid={intervalDaysInvalid}
                        aria-describedby={intervalDaysInvalid ? "routine-interval-days-error" : undefined}
                        className="flex flex-wrap gap-1.5"
                      >
                        {DAY_NAMES.map((label, day) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setIntervalWeekdays((current) => current.includes(day)
                              ? current.filter((value) => value !== day)
                              : [...current, day].sort())}
                            aria-label={`${label}, ${intervalWeekdays.includes(day) ? "selected" : "not selected"}`}
                            aria-pressed={intervalWeekdays.includes(day)}
                            className={cn("size-8 rounded-full text-[10px] font-semibold", intervalWeekdays.includes(day) ? "bg-accent text-white" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}
                          >
                            {DAY_CHIP_LABELS[day]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {intervalWindow === "custom" && (
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span className="font-medium text-ink-secondary">{t("routines.interval.runBetween")}</span>
                      <input aria-label="Interval window start" aria-invalid={intervalWindowInvalid} aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined} type="time" step={CALENDAR_SLOT_MINUTES * 60} value={intervalWindowStart} onChange={(event) => setIntervalWindowStart(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalWindowInvalid ? "border-danger/70" : "border-hairline/50")} />
                      <span className="text-ink-secondary">{t("routines.interval.and")}</span>
                      <input aria-label="Interval window end" aria-invalid={intervalWindowInvalid} aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined} type="time" step={CALENDAR_SLOT_MINUTES * 60} value={intervalWindowEnd} onChange={(event) => setIntervalWindowEnd(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalWindowInvalid ? "border-danger/70" : "border-hairline/50")} />
                    </div>
                  )}

                  {intervalEnd === "on-date" && (
                    <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span className="font-medium text-ink-secondary">{t("routines.interval.stopAfter")}</span>
                      <input aria-label="Interval end date" aria-invalid={intervalEndInvalid} aria-describedby={intervalEndInvalid ? "routine-interval-end-error" : undefined} type="date" min={toLocalDateInput(intervalEndMinimumAt)} value={intervalEndDate} onChange={(event) => setIntervalEndDate(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalEndInvalid ? "border-danger/70" : "border-hairline/50")} />
                    </label>
                  )}

                  {intervalInvalid && (
                    <div id="routine-interval-error" className="text-[11px] text-danger">{t("routines.interval.errorMinutes")}</div>
                  )}
                  {intervalDaysInvalid && (
                    <div id="routine-interval-days-error" className="text-[11px] text-danger">{t("routines.interval.errorDays")}</div>
                  )}
                  {intervalWindowInvalid && (
                    <div id="routine-interval-window-error" className="text-[11px] text-danger">{t("routines.interval.errorWindow", { minutes: intervalMinutes || 5 })}</div>
                  )}
                  {intervalEndInvalid && (
                    <div id="routine-interval-end-error" className="text-[11px] text-danger">{t("routines.interval.errorEndDate")}</div>
                  )}
                  <div id="routine-interval-help" className="text-[11px] leading-relaxed text-ink-secondary">{t(overlap === "queue" ? "routines.overlapQueueHelp" : "routines.overlapSkipHelp")}</div>
                </div>
              )}
    </>
  );
  const runLimitControls = kind === "routine" && (
                <details className="rounded-xl border border-hairline/40 bg-inset/40 px-3 py-2.5">
                  <summary className="cursor-pointer select-none text-[12px] font-medium text-ink-secondary hover:text-ink">
                    {t("routines.advanced.summary", {
                      detail: timeoutMinutes == null
                        ? t("routines.advanced.noRunLimit")
                        : t("routines.advanced.runLimit", { duration: durationLabel(timeoutMinutes) }),
                    })}
                  </summary>
                  <div className="mt-3 border-t border-hairline/35 pt-3">
                    <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span>{t("routines.advanced.stopAfter")}</span>
                      <Select aria-label="Routine safety limit" value={timeoutMinutes ?? ""} onChange={(event) => setTimeoutMinutes(event.target.value ? Number(event.target.value) : null)}>
                        <option value="">{t("routines.advanced.noLimit")}</option>
                        {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                      </Select>
                    </label>
                    <div className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">{t("routines.advanced.timeoutHelp")}</div>
                    {recurrence !== "none" && <div className="mt-3">
                      <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                        <span>{t("routines.overlapLabel")}</span>
                        <Select aria-label={t("routines.overlapLabel")} value={overlap} onChange={event => setOverlap(event.target.value === "queue" ? "queue" : "skip")}>
                          <option value="skip">{t("routines.overlapSkip")}</option>
                          <option value="queue">{t("routines.overlapQueue")}</option>
                        </Select>
                      </label>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">{t(overlap === "queue" ? "routines.overlapQueueHelp" : "routines.overlapSkipHelp")}</p>
                    </div>}
                    {recurrence !== "none" && <label className="mt-3 flex items-start gap-2 text-[12px] text-ink">
                      <input type="checkbox" aria-label={t("routines.runOnStartupLabel")} checked={runOnStartup} onChange={(event) => setRunOnStartup(event.target.checked)} className="mt-0.5 accent-accent" />
                      <span>
                        <span className="block">{t("routines.runOnStartupLabel")}</span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("routines.runOnStartupHelp")}</span>
                      </span>
                    </label>}
                  </div>
                </details>
              );
  const continuityControl = kind === "routine" && !isRoomGoal && recurrence !== "none" && (
          <label className={cn("flex items-start gap-3 rounded-xl border border-hairline/40 bg-inset/40 px-3.5 py-3", advanced && "ml-8")}>
            <input type="checkbox" aria-label={t("routines.continuityLabel")} checked={continuity} onChange={(event) => setContinuity(event.target.checked)} className="mt-0.5 accent-accent" />
            <span>
              <span className="block text-[13px] font-medium text-ink">{t("routines.continuityLabel")}</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("routines.continuityHelp")}</span>
            </span>
          </label>
        );
  const resultsControl = kind === "routine" && !isRoomGoal && <div className={cn(advanced && "ml-8")}>
            <ResultsDestination bot={bots.find((bot) => bot.id === botIds[0])} value={resultsThreadId} allowCurrent={Boolean(existingRoutine)} onChange={setResultsThreadId} />
          </div>;
  const attachmentsRow = (
          <div className="flex items-start gap-4">
            <Paperclip size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            {isRoomGoal ? (
              <div className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3.5 py-3">
                <div className="text-[13px] font-medium text-ink">{t("routines.attachments.sharedContextTitle")}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{t("routines.editor.teamGoalAttachments")}</div>
              </div>
            ) : <div className="min-w-0 flex-1 space-y-2">
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { void pickFiles(event.target.files); event.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg border border-hairline/50 px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised">{t("routines.attachments.add")}</button>
              <AttachmentChips attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
              <div className="text-[11px] leading-relaxed text-ink-secondary">
                {kind === "routine"
                  ? t("routines.attachments.localHelp")
                  : selectedBots.length > 1
                    ? t("routines.attachments.callMulti")
                    : t("routines.attachments.callSingle")}
              </div>
              {attachmentNotice && <div className="text-[12px] text-warning">{attachmentNotice}</div>}
            </div>}
          </div>
  );
  const runOnRow = kind === "routine" && (
            <div className="flex items-start gap-4">
              {isRoomGoal ? <Target size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : runOn === "cloud" ? <Cloud size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : <Laptop size={18} className="mt-2.5 shrink-0 text-ink-secondary" />}
              <div className="min-w-0 flex-1">
                {isRoomGoal ? (
                  <div className="rounded-xl border border-accent/35 bg-accent/[0.07] p-3">
                    <div className="text-[13px] font-medium text-ink">{cloudHome ? t("routines.runsOn.goalCloud") : t("routines.runsOn.goalLocal")}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{t("routines.runsOn.goalCoordination")}</div>
                  </div>
                ) : <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl border p-3 text-left", runOn === "maus" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[13px] font-medium text-ink">{t("routines.runsOn.currentSetup")}</div><div className="mt-1 text-[11px] text-ink-secondary">{t("routines.runsOn.currentSetupHint")}</div></button>
                  <button type="button" disabled={!cloudReady || attachments.length > 0} onClick={() => setRunOn("cloud")} className={cn("rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "border-accent/60 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised")}><div className="text-[13px] font-medium text-ink">{t("routines.runsOn.boat")}</div><div className="mt-1 text-[11px] text-ink-secondary">{t(cloudHome ? "routines.runsOn.boatHintCloudHome" : "routines.runsOn.boatHint")}</div></button>
                </div>}
              </div>
            </div>
          );
  const headerTitle = !advanced && kind === "routine"
    ? t(plain ? (existingRoutine ? "automations.editor.edit" : "automations.editor.new") : existingRoutine ? "routines.editor.edit" : "routines.editor.new")
    : existingRoutine || existingCall ? "Edit event" : "New event";
  const repeatChoices = [
    ["none", "routines.repeat.once"],
    ["daily", "routines.repeat.daily"],
    ["weekdays", "routines.repeat.weekdays"],
    ["weekly", "routines.repeat.weekly"],
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={existingRoutine || existingCall ? "Edit calendar event" : "Create calendar event"} tabIndex={-1} className="max-h-[94vh] w-full max-w-[760px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <div className="text-[15px] font-semibold text-ink">{headerTitle}</div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-8">
          {advanced && kindSwitchControl}

          {advanced && routineTypeControl}

          <div className="flex items-start gap-4">
            <span className="mt-3 size-4 shrink-0 rounded bg-accent" />
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "routine" ? (advanced ? "Add title" : t("routines.editor.titlePlaceholder")) : "Add call title"} className="min-w-0 flex-1 border-b border-hairline/60 bg-transparent px-1 pb-2 text-[22px] font-medium text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
          </div>

          {advanced ? (
            <div className="flex items-start gap-4">
              <Clock3 size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1 space-y-3">
                {whenControls}
                {repeatSelect}
                {scheduleNote}
                {repeatDetails}
                {runLimitControls}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <Clock3 size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="text-[13px] font-medium text-ink">{t("routines.editor.when")}</div>
                {whenControls}
                <div role="group" aria-label={t("routines.editor.repeat")} className="flex flex-wrap gap-1.5">
                  {repeatChoices.map(([choice, label]) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={recurrence === choice}
                      onClick={() => selectRecurrence(choice)}
                      className={cn("rounded-full border px-3 py-1.5 text-[12px] font-medium transition", recurrence === choice ? "border-accent-border bg-accent/15 text-accent-text" : "border-hairline/50 bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
                {!repeatChoices.some(([choice]) => choice === recurrence) && <div className="text-[12px] text-ink-secondary">{t("routines.editor.customRepeat")}</div>}
              </div>
            </div>
          )}

          <div className="flex items-start gap-4">
            {isRoomGoal ? <UsersRound size={18} className="mt-2.5 shrink-0 text-ink-secondary" /> : <UserRoundPlus size={18} className="mt-2.5 shrink-0 text-ink-secondary" />}
            <div className="min-w-0 flex-1">
              {isRoomGoal ? (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="routine-goal-room" className="mb-2 block text-[13px] font-medium text-ink">{t("routines.editor.goalWhere")}</label>
                    <Select id="routine-goal-room" value={groupId} onChange={(event) => selectRoom(event.target.value)} className="w-full">
                      <option value="">{t("routines.editor.goalOneOnOne")}</option>
                      {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                    </Select>
                  </div>
                  <div>
                    <div className="mb-2 text-[13px] font-medium text-ink">{selectedRoom ? "Choose the lead" : t("routines.editor.who")}</div>
                    {roomMembers.length > 0 ? (
                      <>
                        <BotPicker bots={roomMembers} selected={botIds} multiple={false} onChange={selectBots} />
                        <div className="mt-2 text-[12px] text-ink-secondary">{selectedRoom ? `The lead coordinates ${selectedRoom.name} and assigns work to its active members.` : t("routines.editor.goalOneOnOneHelp")}</div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[12px] text-warning">This group has no active members. Add or restore a bot before scheduling the goal.</div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 text-[13px] font-medium text-ink">{kind === "routine" ? (advanced ? "Assign a bot" : t("routines.editor.who")) : "Add guests"}</div>
                  {bots.length > 0 ? (
                <>
                  <BotPicker bots={bots} selected={botIds} multiple={kind === "call"} locked={Boolean(lockedBotId)} onChange={selectBots} />
                  <div className="mt-2 text-[12px] text-ink-secondary">{kind === "routine" ? "This bot owns each scheduled run." : `${selectedBots.length || "No"} bot${selectedBots.length === 1 ? "" : "s"} invited to the call.`}</div>
                </>
              ) : (
                <button type="button" onClick={() => { dispatch({ type: "toggleNewBot", open: true }); onClose(); }} className="w-full rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-4 py-4 text-left hover:bg-accent/10">
                  <div className="text-[13px] font-medium text-accent">Create your first bot</div>
                  <div className="mt-1 text-[12px] text-ink-secondary">A calendar event needs at least one bot.</div>
                </button>
                  )}
                </>
              )}
            </div>
          </div>

          {advanced && resultsControl}
          <div className="flex items-start gap-4">
            <FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder={isRoomGoal ? "What should the team accomplish?" : kind === "routine" ? (advanced ? "Add instructions for the bot" : t("routines.editor.instructionsPlaceholder")) : "Add description or agenda"} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
          </div>
          {continuityControl}

          {advanced && attachmentsRow}

          {advanced && runOnRow}

          {!advanced && (
            <div>
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls="routine-more-options"
                onClick={() => setMoreOpen((open) => !open)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-accent-text hover:bg-raised"
              >
                <ChevronRight size={14} className={cn("transition-transform", moreOpen && "rotate-90")} />
                {t(moreOpen ? "routines.editor.fewer" : "routines.editor.more")}
              </button>
              {moreOpen && (
                <div id="routine-more-options" className="mt-3 space-y-5 rounded-xl border border-hairline/40 bg-inset/30 p-4">
                  {kindSwitchControl}
                  {routineTypeControl}
                  <div className="space-y-3">
                    {repeatSelect}
                    {scheduleNote}
                    {repeatDetails}
                    {runLimitControls}
                  </div>
                  {resultsControl}
                  {attachmentsRow}
                  {runOnRow}
                </div>
              )}
            </div>
          )}

          {error && <div className="ml-10 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
        </div>


        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("common.cancel")}</button>
          <button onClick={save} disabled={saving || attachmentPending || !valid} className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{(saving || attachmentPending) && <Loader2 size={14} className="animate-spin" />}{attachmentPending ? "Attaching…" : existingRoutine || existingCall || (kind === "routine" && !isRoomGoal) ? t("automations.editor.app.save") : kind === "call" ? "Schedule call" : "Schedule team goal"}</button>
        </div>
      </div>
    </div>
  );
}
