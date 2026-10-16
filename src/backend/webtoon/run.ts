/**
 * Webtoon strip run (experimental webtoon mode): planner call -> code validation -> one NovelAI V5 image per image
 * panel (sequential, through the engine dispatcher and the ImageService queue) -> layout, persisted after every step so
 * the chat view shows panels as they finish. Also single-panel reroll and text edits.
 */
import { rpcError, type ChatDataDocument, type InlayConfig, type RpcError, type WebtoonStripView } from "../../shared/contract/index.js";
import { isAbortLike, RpcFailure, toRpcError } from "../rpc/errors.js";
import type { BackendServices, ChatInfo } from "../services/types.js";
import type { EnginePort } from "../pipeline/engine-port.js";
import type { ChatMessageView } from "../pipeline/host-chat.js";
import { buildPlannerPrompt, chosenOutfits } from "./planner-prompt.js";
import { buildPanelRequest, engineImageRequest, type PanelRequest, type WebtoonStyle } from "./panel-request.js";
import { castFor, loadWebtoonContext, validationRoster } from "./roster.js";
import type { ImagePanel } from "./storyboard-schema.js";
import { hardOk, validateStoryboard } from "./storyboard-validate.js";
import { createStripDocument, readStrip, relayout, stripView, takeOf, updateStrip, type PlannerCall, type WebtoonStripDocument } from "./store.js";

const MAX_PLANNER_CALLS = 3;
/** One planner call may take 2 minutes (bench source c: 132 s). */
const PLANNER_TIMEOUT_MS = 300_000;

export interface WebtoonDeps {
  services: BackendServices;
  engine: EnginePort;
  now?: () => number;
}

export interface WebtoonProgress {
  stage: "planning" | "generating" | "committing";
  /** Panels finished / total (generating). */
  done?: number;
  total?: number;
}

export interface WebtoonRunRequest {
  chatId: string;
  chat: ChatInfo;
  messages: ChatMessageView[];
  /** Index into `messages`. */
  target: number;
  historyId: string;
  planKey: string;
  /** Clean text of the target swipe. */
  source: string;
  config: InlayConfig;
  chatData: ChatDataDocument;
  signal: AbortSignal;
  /** Throws when the target message/swipe is no longer current. */
  assertTarget: () => Promise<void>;
  onProgress: (progress: WebtoonProgress) => void;
  /** The strip document changed (the controller emits chatData.changed). */
  onChanged: () => void;
  /** Retry: keep the stored storyboard and draw only the panels without an image. */
  resume?: boolean;
}

export interface WebtoonRunResult {
  status: "complete" | "error" | "cancelled";
  error?: RpcError;
  failedPanels: number;
}

const aborted = () => new DOMException("Webtoon generation was cancelled.", "AbortError");

async function requireNovelAI(services: BackendServices) {
  const target = await services.images.resolveTarget();
  if (target.generationProvider !== "novelai")
    throw new RpcFailure(rpcError("unsupported", "Webtoon mode needs a NovelAI image connection.", { retryable: false }));
  return target;
}

/** One panel image through the engine dispatcher (NovelAI adapter, ImageService queue, dispatcher retries). */
async function generatePanel(deps: WebtoonDeps, input: { request: PanelRequest; style: WebtoonStyle; seed: string; chatId: string; characterId: string; config: InlayConfig; signal: AbortSignal }) {
  const target = await requireNovelAI(deps.services);
  const result = await deps.engine.dispatch(
    engineImageRequest(input.request, input.style, input.seed),
    {
      engineProvider: "novelai",
      purpose: "chat",
      connectionId: target.connectionId,
      model: target.model,
      ownerChatId: input.chatId,
      ownerCharacterId: input.characterId,
      forceNsfwPrefix: () => false,
    },
    input.config,
    { signal: input.signal },
  );
  const meta = (result.providerMetadata ?? {}) as Record<string, unknown>;
  const imageId = String(meta.imageId ?? result.requestId ?? "").trim();
  if (!imageId) throw new Error("The image provider returned no image id.");
  const now = (deps.now ?? Date.now)();
  return takeOf(imageId, String(result.seed ?? ""), Math.round(Number(result.width) || input.request.width), Math.round(Number(result.height) || input.request.height), now);
}

async function plan(deps: WebtoonDeps, prompt: string, signal: AbortSignal): Promise<{ raw: unknown; model: string; calls: PlannerCall[] }> {
  const calls: PlannerCall[] = [];
  let model = "";
  for (let attempt = 0; attempt < MAX_PLANNER_CALLS; attempt += 1) {
    if (signal.aborted) throw aborted();
    const started = Date.now();
    try {
      const result = await deps.services.llm.complete(
        { purpose: "webtoon-planner", messages: [{ role: "user", content: prompt }], responseMode: "json", settings: { timeoutMs: PLANNER_TIMEOUT_MS }, retries: 0 },
        { signal },
      );
      model = result.model;
      const ok = hardOk(result.parsed);
      calls.push({ ms: result.latencyMs, finishReason: result.finishReason, parsed: true, hardOk: ok });
      if (ok) return { raw: result.parsed, model, calls };
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) throw error;
      calls.push({ ms: Date.now() - started, finishReason: "", parsed: false, hardOk: false, error: toRpcError(error).message });
    }
  }
  const last = calls.at(-1);
  throw Object.assign(
    new RpcFailure(rpcError("provider-error", last?.error ? `The webtoon planner failed: ${last.error}` : "The webtoon planner returned no usable storyboard (6 to 8 image panels).", { retryable: true })),
    { calls, model },
  );
}

/** Plan and draw the strip of one message swipe. Never throws for panel failures (they are counted). */
export async function runWebtoonStrip(deps: WebtoonDeps, req: WebtoonRunRequest): Promise<WebtoonRunResult> {
  const { services } = deps;
  const now = deps.now ?? Date.now;
  const write = async (mutate: (doc: WebtoonStripDocument) => void) => {
    const doc = await updateStrip(services.storage, req.chatId, req.historyId, (current) => {
      const next = current ?? createStripDocument({ chatId: req.chatId, messageKey: req.planKey, historyId: req.historyId, characterId: "", sourceLength: req.source.length, now: now() });
      mutate(next);
      return next;
    }, now);
    req.onChanged();
    return doc;
  };
  let doc: WebtoonStripDocument | null = null;
  try {
    await requireNovelAI(services);
    req.onProgress({ stage: "planning" });
    const previous = await readStrip(services.storage, req.chatId, req.historyId);
    let style: WebtoonStyle;
    let characterId: string;
    if (req.resume && previous?.storyboard && previous.style && Object.keys(previous.requests).length) {
      // Retry: keep the storyboard, draw only the panels without an image.
      style = previous.style;
      characterId = previous.characterId;
      doc = await write((d) => {
        d.status = "generating";
        delete d.error;
      });
    } else {
      const context = await loadWebtoonContext(services, { ...req });
      style = context.style;
      characterId = context.characterId;
      doc = await write((d) => {
        Object.assign(d, createStripDocument({ chatId: req.chatId, messageKey: req.planKey, historyId: req.historyId, characterId, sourceLength: req.source.length, now: now(), revision: previous?.revision ?? 0 }));
      });
      let planned: Awaited<ReturnType<typeof plan>>;
      try {
        planned = await plan(deps, buildPlannerPrompt({ roster: context.roster, source: req.source }), req.signal);
      } catch (error) {
        const meta = error as { calls?: PlannerCall[]; model?: string };
        if (meta.calls) await write((d) => void (d.planner = { model: meta.model ?? "", calls: meta.calls! }));
        throw error;
      }
      await req.assertTarget();
      const outfitLog: string[] = [];
      const outfits = chosenOutfits(planned.raw, context.roster, outfitLog);
      const validated = validateStoryboard(structuredClone(planned.raw), validationRoster(context.roster, outfits), req.source);
      validated.log.unshift(...outfitLog);
      const cast = castFor(context.roster, outfits);
      const planImages = validated.storyboard.panels.filter((p): p is ImagePanel => p.kind === "image");
      doc = await write((d) => {
        d.planner = { model: planned.model, calls: planned.calls };
        d.storyboardRaw = planned.raw;
        d.storyboard = validated.storyboard;
        d.validation = { log: validated.log, stats: validated.stats };
        d.cast = context.roster.map((r) => ({ name: r.name, key: r.key, outfitId: cast.get(r.name)?.outfitId ?? r.currentOutfitId }));
        d.style = context.style;
        d.requests = Object.fromEntries(planImages.map((p) => [String(p.id), buildPanelRequest(p, cast, context.style)]));
        d.panels = Object.fromEntries(planImages.map((p) => [String(p.id), { panelId: String(p.id), status: "pending", takes: [], selected: -1 }]));
        d.status = "generating";
        d.layout = relayout(d);
      });
    }
    const requests = doc.requests;
    const images = (doc.storyboard?.panels ?? []).filter((p): p is ImagePanel => p.kind === "image" && !!requests[String(p.id)]);
    const todo = images.filter((p) => doc!.panels[String(p.id)]?.status !== "done");

    let failed = 0;
    for (const [index, panel] of todo.entries()) {
      if (req.signal.aborted) throw aborted();
      const id = String(panel.id);
      req.onProgress({ stage: "generating", done: images.length - todo.length + index, total: images.length });
      try {
        const take = await generatePanel(deps, { request: requests[id]!, style, seed: "", chatId: req.chatId, characterId, config: req.config, signal: req.signal });
        await req.assertTarget();
        doc = await write((d) => {
          const p = d.panels[id]!;
          p.takes.push(take);
          p.selected = p.takes.length - 1;
          p.status = "done";
          delete p.error;
          d.layout = relayout(d);
        });
      } catch (error) {
        if (req.signal.aborted || isAbortLike(error)) throw error;
        failed += 1;
        const message = toRpcError(error).message;
        doc = await write((d) => {
          d.panels[id] = { ...d.panels[id]!, status: "error", error: message };
        });
        services.log.append("warn", "webtoon", `Panel ${id} failed`, { chatId: req.chatId, historyId: req.historyId, error: message });
      }
    }
    req.onProgress({ stage: "committing" });
    const error = failed ? rpcError("provider-error", `${failed} webtoon panel(s) failed to generate.`, { retryable: true }) : undefined;
    await write((d) => {
      d.status = failed ? "error" : "complete";
      if (error) d.error = error.message;
      else delete d.error;
    });
    return { status: failed ? "error" : "complete", ...(error ? { error } : {}), failedPanels: failed };
  } catch (e) {
    const cancelled = req.signal.aborted || isAbortLike(e);
    const error = cancelled ? undefined : toRpcError(e);
    await write((d) => {
      d.status = cancelled ? "cancelled" : "error";
      if (error) d.error = error.message;
    }).catch(() => undefined);
    return cancelled ? { status: "cancelled", failedPanels: 0 } : { status: "error", error: error!, failedPanels: 0 };
  }
}

/** New take of one panel (random seed); the new take is selected and the strip laid out again. */
export async function rerollWebtoonPanel(
  deps: WebtoonDeps,
  req: { chatId: string; historyId: string; panelId: string; config: InlayConfig; signal: AbortSignal; onChanged: () => void },
): Promise<WebtoonStripView> {
  const doc = await readStrip(deps.services.storage, req.chatId, req.historyId);
  const request = doc?.requests[req.panelId];
  if (!doc || !request || !doc.style) throw new RpcFailure(rpcError("not-found", "This webtoon panel has no image request.", { retryable: false }));
  const take = await generatePanel(deps, { request, style: doc.style, seed: "", chatId: req.chatId, characterId: doc.characterId, config: req.config, signal: req.signal });
  if (req.signal.aborted) throw aborted();
  const written = await updateStrip(deps.services.storage, req.chatId, req.historyId, (current) => {
    const d = current ?? doc;
    const p = d.panels[req.panelId] ?? { panelId: req.panelId, status: "pending" as const, takes: [], selected: -1 };
    p.takes.push(take);
    p.selected = p.takes.length - 1;
    p.status = "done";
    delete p.error;
    d.panels[req.panelId] = p;
    d.layout = relayout(d);
    return d;
  }, deps.now);
  req.onChanged();
  return stripView(written);
}

/** Replace the text of one text item (the original text again removes the override) and lay the strip out again. */
export async function editWebtoonText(
  deps: WebtoonDeps,
  req: { chatId: string; historyId: string; panelId: string; textIndex: number; text: string },
): Promise<WebtoonStripView> {
  const text = req.text.replace(/\s+/gu, " ").trim();
  if (!text) throw new RpcFailure(rpcError("bad-request", "The text is empty.", { retryable: false }));
  const written = await updateStrip(deps.services.storage, req.chatId, req.historyId, (current) => {
    const panel = current?.storyboard?.panels.find((p) => String(p.id) === req.panelId);
    const original = panel?.text[req.textIndex];
    if (!current || !original) throw new RpcFailure(rpcError("not-found", "This webtoon text item does not exist.", { retryable: false }));
    const key = `${req.panelId}:${req.textIndex}`;
    if (text === original.text) delete current.textOverrides[key];
    else current.textOverrides[key] = text;
    current.layout = relayout(current);
    return current;
  }, deps.now);
  return stripView(written);
}
