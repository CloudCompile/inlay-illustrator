/**
 * Pure runtime-toast models for the chat side (Asset Maid `$Ct` 177880, `MCt` 177783, `dht` 114252,
 * spec/ui.md §5.2 and §6.3): generation jobs (running + finished), notices and chat-side errors.
 */
import type { AttemptKind, GenerationJobSnapshot, GenerationResultKind, JevSelectionProgress, RpcError } from "../../shared/contract/rpc.js";
import { fill, JEV_LABELS, PHASE_LABELS, TOAST_LABELS } from "./labels.js";

export type RuntimeToastTone = "running" | "success" | "warning" | "danger";
export type RuntimeToastAction = "cancel" | "retry" | "dismiss" | "none";

export interface RuntimeToastModel {
  key: string;
  kind: "generation" | "notice" | "jev-selection";
  tone: RuntimeToastTone;
  message: string;
  /** Formatted retry count `${attempt}/${total}` when retrying (AM `retryCount`). */
  retryCount?: string;
  detail?: string;
  /** Long error text (shown when the toast is expanded). */
  errorText?: string;
  /** 0..1 */
  progress: number;
  action: RuntimeToastAction;
  canRestart?: boolean;
  jobId?: string;
  displayIndex?: number;
  /** Child rows (JEV roster) render under the toast with this key. */
  parentKey?: string;
  technologyBadge?: string;
  technologyBadgeTitle?: string;
  /** Auto-dismiss after ms (0 = stay). */
  autoDismissMs: number;
  createdAt: number;
}

/** A finished generation remembered by the stack until dismissed. */
export interface FinishedGeneration {
  jobId: string;
  chatId: string;
  messageKey: string;
  result: GenerationResultKind;
  attemptKind: AttemptKind;
  requestedCount: number;
  completedSlots: number;
  canRetry: boolean;
  canRestart: boolean;
  error?: RpcError;
  jevSelection?: JevSelectionProgress;
  finishedAt: number;
}

/** Asset Maid auto-dismiss: success/warning toasts after 10 s; running/danger stay. */
export const TOAST_AUTO_DISMISS_MS = 10_000;
export const NOTICE_AUTO_DISMISS_MS = 6_000;
/** AM `iCt`: a settled JEV row closes after 5 s. */
export const JEV_AUTO_DISMISS_MS = 5_000;
const START = 0.04;

function imagesText(n: number): string {
  return n === 1 ? TOAST_LABELS.oneImage : fill(TOAST_LABELS.images, { n });
}

function isRegenerate(kind: AttemptKind): boolean {
  return kind === "regenerate";
}

/** AM `dht`: progress fraction of a running job (uses the backend fraction when it sends one). */
export function generationProgress(job: GenerationJobSnapshot): number {
  if (typeof job.progress.fraction === "number" && Number.isFinite(job.progress.fraction)) return Math.min(1, Math.max(0, job.progress.fraction));
  const count = Math.max(1, job.requestedCount);
  const done = Math.max(0, job.completedSlots);
  const ratio = job.progress.total ? Math.min(1, (job.progress.done ?? 0) / job.progress.total) : 0;
  if (isRegenerate(job.attemptKind)) {
    switch (job.phase) {
      case "analyzing-preset":
      case "analyzing-modifiers": return Math.max(job.phase === "analyzing-preset" ? 0.08 : 0.28, 0.45 * ratio);
      case "planning": return 0.5;
      case "committing": return 0.97;
      case "generating": return 0.6 + 0.36 * Math.min(1, done / count);
      default: return 0.03;
    }
  }
  const step = (1 - START) / (count + 2);
  switch (job.phase) {
    case "analyzing-preset":
    case "analyzing-modifiers": return START + 2 * step * ratio;
    case "planning": return START + 2 * step;
    case "committing": return 0.99;
    case "generating": return Math.min(0.99, START + step * (2 + Math.min(count, done)));
    default: return START;
  }
}

/** Toast message of a running job. */
export function runningMessage(job: GenerationJobSnapshot): string {
  const count = Math.max(1, job.requestedCount);
  let message: string;
  if (isRegenerate(job.attemptKind)) {
    message = job.status === "queued" ? TOAST_LABELS.regenWaiting : TOAST_LABELS.regenRunning;
  } else if (job.status === "queued" || job.phase === "planned") {
    message = TOAST_LABELS.waiting;
  } else if (job.phase === "analyzing-preset" || job.phase === "analyzing-modifiers" || job.phase === "planning") {
    message = `${job.jevSelection?.status === "running" ? TOAST_LABELS.waiting : TOAST_LABELS.analyzing} · ${imagesText(job.requestedCount || 1)}`;
  } else {
    message = `${TOAST_LABELS.generating} · ${Math.min(count, job.completedSlots + 1)}/${count}`;
  }
  const retry = job.progress.retry;
  if (retry && retry.attempt > 0) message += ` · ${fill(TOAST_LABELS.retryAttempt, { a: retry.attempt, t: retry.total })}`;
  return message;
}

/** Detail line: queue prefix + phase label (AM `fht`/`mht`). */
export function runningDetail(job: GenerationJobSnapshot): string {
  const parts: string[] = [];
  const queue = job.progress.queue;
  if (queue && queue.position >= 1 && queue.depth >= 1) parts.push(fill(TOAST_LABELS.queue, { p: queue.position, d: queue.depth }));
  const label = job.progress.label || PHASE_LABELS[job.phase] || "";
  if (label) parts.push(label);
  return parts.join(" · ");
}

export function runningToast(job: GenerationJobSnapshot, now: number): RuntimeToastModel {
  const retry = job.progress.retry;
  const retryCount = job.progress.retryCount || (retry && retry.attempt > 0 ? `${retry.attempt}/${retry.total}` : undefined);
  return {
    key: `generation:${job.jobId}`,
    kind: "generation",
    tone: "running",
    message: runningMessage(job),
    retryCount,
    detail: runningDetail(job) || undefined,
    progress: generationProgress(job),
    action: "cancel",
    jobId: job.jobId,
    autoDismissMs: 0,
    createdAt: now
  };
}

/** AM `sCt` 176461: the JEV roster row under a generation toast. A row still running when its job ended reads as stopped. */
export function jevToast(selection: JevSelectionProgress, parentKey: string, jobActive: boolean, createdAt = 0): RuntimeToastModel {
  const status = selection.status === "running" && !jobActive ? "cancelled" : selection.status;
  const total = Math.max(0, selection.total);
  const done = Math.min(total, Math.max(0, selection.completed));
  const detail =
    status === "running"
      ? fill(JEV_LABELS.checking, { a: done, t: total })
      : status === "completed"
        ? selection.selectedActors !== undefined
          ? fill(JEV_LABELS.actors, { n: selection.selectedActors })
          : JEV_LABELS.selected
        : status === "failed"
          ? JEV_LABELS.failed
          : JEV_LABELS.stopped;
  return {
    key: `${parentKey}:jev:${status}`,
    kind: "jev-selection",
    parentKey,
    tone: status === "failed" ? "danger" : status === "running" ? "running" : status === "completed" ? "success" : "warning",
    message: JEV_LABELS.message,
    technologyBadge: "JEV",
    technologyBadgeTitle: JEV_LABELS.badgeTitle,
    detail,
    ...(status === "failed" ? { errorText: selection.error || JEV_LABELS.failedDetail } : {}),
    progress: status === "completed" ? 1 : total ? done / total : 0,
    action: "none",
    autoDismissMs: status === "running" ? 0 : JEV_AUTO_DISMISS_MS,
    createdAt
  };
}

export function finishedToast(entry: FinishedGeneration): RuntimeToastModel {
  const regen = isRegenerate(entry.attemptKind);
  const base = { key: `generation:${entry.jobId}`, kind: "generation" as const, jobId: entry.jobId, createdAt: entry.finishedAt };
  if (entry.result === "completed" || entry.result === "presentation-deferred") {
    const n = entry.completedSlots || entry.requestedCount;
    return { ...base, tone: "success", message: regen ? TOAST_LABELS.regenComplete : n > 0 ? `${TOAST_LABELS.complete} · ${imagesText(n)}` : TOAST_LABELS.complete, progress: 1, action: "dismiss", autoDismissMs: TOAST_AUTO_DISMISS_MS };
  }
  if (entry.result === "cancelled") {
    return { ...base, tone: "warning", message: regen ? TOAST_LABELS.regenStopped : TOAST_LABELS.stopped, progress: 0, action: "dismiss", autoDismissMs: TOAST_AUTO_DISMISS_MS };
  }
  const analyzer = /ANALYZER|analy/iu.test(`${entry.error?.detailCode ?? ""}`);
  const message = regen ? TOAST_LABELS.regenFailed : analyzer ? TOAST_LABELS.analysisFailed : TOAST_LABELS.failed;
  return {
    ...base,
    tone: "danger",
    message,
    detail: entry.error?.message,
    errorText: entry.error?.message,
    progress: 0,
    action: entry.canRetry ? "retry" : "dismiss",
    canRestart: entry.canRestart,
    autoDismissMs: 0
  };
}

export interface NoticeEntry { key: string; tone: "info" | "success" | "warning" | "danger"; message: string; detail?: string; createdAt: number }

export function noticeToast(notice: NoticeEntry): RuntimeToastModel {
  const tone: RuntimeToastTone = notice.tone === "danger" ? "danger" : notice.tone === "warning" ? "warning" : "success";
  return {
    key: `notice:${notice.key}`,
    kind: "notice",
    tone,
    message: notice.message,
    detail: notice.detail,
    errorText: tone === "danger" ? notice.detail : undefined,
    progress: tone === "danger" ? 0 : 1,
    action: "dismiss",
    autoDismissMs: tone === "danger" ? 0 : NOTICE_AUTO_DISMISS_MS,
    createdAt: notice.createdAt
  };
}

/**
 * Builds the stack (AM order: generation jobs by display index, then notices), skipping dismissed keys.
 * `displayIndex` assigns "#n" job numbers in first-seen order.
 */
export function buildToastStack(input: {
  running: GenerationJobSnapshot[];
  finished: FinishedGeneration[];
  notices: NoticeEntry[];
  dismissed: ReadonlySet<string>;
  displayIndex: Map<string, number>;
  /** First time each JEV row key was shown (keeps its auto-dismiss clock across rebuilds). */
  seenAt: Map<string, number>;
  now: number;
}): RuntimeToastModel[] {
  const out: RuntimeToastModel[] = [];
  const seen = new Set<string>();
  const indexOf = (jobId: string) => {
    let n = input.displayIndex.get(jobId);
    if (n === undefined) {
      n = input.displayIndex.size + 1;
      input.displayIndex.set(jobId, n);
    }
    return n;
  };
  const generation: RuntimeToastModel[][] = [];
  const add = (toast: RuntimeToastModel, displayIndex: number, selection: JevSelectionProgress | undefined, active: boolean) => {
    const group = [{ ...toast, displayIndex }];
    if (selection) {
      const child = jevToast(selection, toast.key, active);
      if (!input.seenAt.has(child.key)) input.seenAt.set(child.key, input.now);
      if (!input.dismissed.has(child.key)) group.push({ ...child, displayIndex, createdAt: input.seenAt.get(child.key)! });
    }
    generation.push(group);
  };
  for (const job of input.running) {
    if (job.status !== "queued" && job.status !== "running") continue;
    const toast = runningToast(job, input.now);
    if (input.dismissed.has(toast.key)) continue;
    seen.add(job.jobId);
    add(toast, indexOf(job.jobId), job.jevSelection, true);
  }
  for (const entry of input.finished) {
    if (seen.has(entry.jobId)) continue;
    const toast = finishedToast(entry);
    if (input.dismissed.has(toast.key)) continue;
    add(toast, indexOf(entry.jobId), entry.jevSelection, false);
  }
  generation.sort((a, b) => (a[0].displayIndex ?? 0) - (b[0].displayIndex ?? 0));
  out.push(...generation.flat());
  for (const notice of input.notices) {
    const toast = noticeToast(notice);
    if (!input.dismissed.has(toast.key)) out.push(toast);
  }
  return out;
}
