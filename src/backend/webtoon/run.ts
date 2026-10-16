/**
 * Webtoon strip run (experimental webtoon mode): planner call -> code validation -> one NovelAI V5 image per image
 * panel (sequential, through the engine dispatcher and the ImageService queue; frame-break panels: cut-out + inpainted background)
 * -> layout, persisted after every step so
 * the chat view shows panels as they finish. Also single-panel reroll and text edits.
 */
import { rpcError, type ChatDataDocument, type InlayConfig, type RpcError, type WebtoonPanelTake, type WebtoonStripView } from "../../shared/contract/index.js";
import { isAbortLike, RpcFailure, toRpcError } from "../rpc/errors.js";
import type { BackendServices, ChatInfo } from "../services/types.js";
import type { EnginePort } from "../pipeline/engine-port.js";
import { base64ToBytes, buildNovelAIRequest, bytesToBase64 } from "../pipeline/providers.js";
import type { ChatMessageView } from "../pipeline/host-chat.js";
import { buildPlannerPrompt, chosenOutfits, webtoonPanelRange, webtoonPanelTarget } from "./planner-prompt.js";
import { buildPanelRequest, CUTOUT_NEGATIVE, engineImageRequest, type PanelRequest, type WebtoonStyle } from "./panel-request.js";
import { castFor, loadWebtoonContext, validationRoster } from "./roster.js";
import { characterGrid, decodePng, encodePng, flattenOver, frameBreakInputs, type RgbaImage } from "./cutout.js";
import type { ImagePanel } from "./storyboard-schema.js";
import { hardOk, validateStoryboard } from "./storyboard-validate.js";
import { createStripDocument, readStrip, stripView, takeOf, updateStrip, type PlannerCall, type WebtoonStripDocument } from "./store.js";

const MAX_PLANNER_CALLS = 3;
/** NovelAI Opus allows one generation at a time per account: "429 Concurrent generation is locked" while another client
 * (another tab, another app) draws. The dispatcher's quick retries are not enough; wait like the bench did. */
const LOCK_WAIT_MS = 4000;
const LOCK_RETRIES = 8;
const CONCURRENT_LOCK = /\b429\b|concurrent generation/iu;
/** One planner call may take 2 minutes (bench source c: 132 s). */
const PLANNER_TIMEOUT_MS = 300_000;
/** NovelAI V5 inpainting model (0 Anlas on Opus at panel sizes; nai-alpha bench). */
const INPAINT_MODEL = "nai-diffusion-5-full-inpainting";

export interface WebtoonDeps {
  services: BackendServices;
  engine: EnginePort;
  now?: () => number;
  /** Wait between attempts while NovelAI reports a concurrent generation (tests). */
  lockWaitMs?: number;
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

interface PanelInput { request: PanelRequest; style: WebtoonStyle; seed: string; chatId: string; characterId: string; config: InlayConfig; signal: AbortSignal }

/** Retry while NovelAI reports a concurrent generation on the account. */
async function waitOutLock<T>(deps: WebtoonDeps, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (signal.aborted || attempt >= LOCK_RETRIES || !CONCURRENT_LOCK.test(toRpcError(error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, deps.lockWaitMs ?? LOCK_WAIT_MS));
      if (signal.aborted) throw aborted();
    }
  }
}

/** One panel image through the engine dispatcher (NovelAI adapter, ImageService queue, dispatcher retries). */
async function generatePanel(deps: WebtoonDeps, input: PanelInput): Promise<WebtoonPanelTake> {
  const target = await requireNovelAI(deps.services);
  const result = await waitOutLock(deps, input.signal, () =>
    deps.engine.dispatch(
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
    ),
  );
  const meta = (result.providerMetadata ?? {}) as Record<string, unknown>;
  const imageId = String(meta.imageId ?? result.requestId ?? "").trim();
  if (!imageId) throw new Error("The image provider returned no image id.");
  const now = (deps.now ?? Date.now)();
  return takeOf(imageId, String(result.seed ?? ""), Math.round(Number(result.width) || input.request.width), Math.round(Number(result.height) || input.request.height), now);
}

/**
 * One NovelAI image straight through the ImageService: the engine request has no field for the raw override (infill) or a
 * second model. Same request building as the engine's NovelAI adapter. Returns the result and its PNG bytes.
 */
async function drawDirect(deps: WebtoonDeps, input: PanelInput & { prompt: string; model: string; connectionId: string; rawOverride?: Record<string, unknown> }) {
  const build = buildNovelAIRequest(engineImageRequest({ ...input.request, prompt: input.prompt }, input.style, input.seed), {
    purpose: "chat",
    connectionId: input.connectionId,
    model: input.model,
    ownerChatId: input.chatId,
    ownerCharacterId: input.characterId,
    forceNsfwPrefix: () => false,
  });
  const { retries: _engineRetries, ...request } = build.request;
  const novelai = { ...request.novelai, ...(input.rawOverride ? { rawOverride: input.rawOverride } : {}) };
  const result = await waitOutLock(deps, input.signal, () => deps.services.images.generate({ ...request, novelai, includeData: true }, { signal: input.signal }));
  if (!result.dataBase64) throw new Error("The image provider returned no image data.");
  return { result, bytes: base64ToBytes(result.dataBase64) };
}

/**
 * Frame-break panel (nai-alpha route 4): the character drawn on a transparent background, the scene inpainted around it,
 * the cut-out drawn over the flattened result. Both images are uploaded; the two raw generations are deleted.
 * Skipped (throws) when the connection's saved parameters cannot be read: our raw override would replace a saved one.
 */
async function generateFrameBreakPanel(deps: WebtoonDeps, input: PanelInput): Promise<WebtoonPanelTake> {
  const { services } = deps;
  const target = await requireNovelAI(services);
  if (!target.connectionDefaultsReadable) throw new Error("The NovelAI connection's saved parameters could not be read, so a saved raw override would be replaced.");
  const generated: string[] = [];
  try {
    const { cutout } = input.request;
    const cutRequest = {
      ...input.request,
      negativePrompt: `${input.request.negativePrompt}, ${CUTOUT_NEGATIVE}`,
      characters: input.request.characters.map((c, i) => ({ ...c, prompt: cutout!.characters[i] ?? c.prompt })),
    };
    const cut = await drawDirect(deps, { ...input, request: cutRequest, prompt: cutout!.prompt, model: target.model, connectionId: target.connectionId });
    generated.push(cut.result.imageId);
    const fb = await frameBreakInputs(await decodePng(cut.bytes));
    const rawOverride = { action: "infill", parameters: { image: bytesToBase64(fb.source), mask: bytesToBase64(fb.mask), add_original_image: true, inpaintImg2ImgStrength: 1, noise: 0 } };
    const bg = await drawDirect(deps, { ...input, seed: cut.result.seed, prompt: input.request.prompt, model: INPAINT_MODEL, connectionId: target.connectionId, rawOverride });
    generated.push(bg.result.imageId);
    const panel = flattenOver(await decodePng(bg.bytes), fb.cutout);
    const upload = async (image: RgbaImage, name: string) =>
      (await services.host.images.upload(
        { data: await encodePng(image), filename: `${name}.png`, mime_type: "image/png", owner_chat_id: input.chatId, ...(input.characterId ? { owner_character_id: input.characterId } : {}) },
        services.userId,
      )).id;
    const panelId = await upload(panel, `webtoon-panel-${input.request.panelId}`);
    const cutoutId = await upload(fb.display, `webtoon-cutout-${input.request.panelId}`);
    // Uploads are served by the session route only (the public results route serves image-gen files).
    const url = (id: string) => `/api/v1/images/${encodeURIComponent(id)}`;
    return {
      ...takeOf(panelId, cut.result.seed, panel.width, panel.height, (deps.now ?? Date.now)()),
      url: url(panelId),
      cutout: { imageId: cutoutId, url: url(cutoutId), bbox: fb.info.bbox!, mask: characterGrid(fb.cutout) },
    };
  } finally {
    if (generated.length) void services.images.deleteImages(generated.filter(Boolean)).catch(() => undefined);
  }
}

/** A frame-break panel falls back to the plain panel when either step fails. */
async function drawPanel(deps: WebtoonDeps, input: PanelInput): Promise<WebtoonPanelTake> {
  if (input.request.cutout) {
    try {
      return await generateFrameBreakPanel(deps, input);
    } catch (error) {
      if (input.signal.aborted || isAbortLike(error)) throw error;
      deps.services.log.append("warn", "webtoon", `Panel ${input.request.panelId}: frame-break skipped, drawing the plain panel`, { error: toRpcError(error).message });
    }
  }
  return generatePanel(deps, input);
}

async function plan(deps: WebtoonDeps, prompt: string, images: { min: number; max: number }, signal: AbortSignal): Promise<{ raw: unknown; model: string; calls: PlannerCall[] }> {
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
      const ok = hardOk(result.parsed, images);
      calls.push({ ms: result.latencyMs, finishReason: result.finishReason, parsed: true, hardOk: ok });
      if (ok) return { raw: result.parsed, model, calls };
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) throw error;
      calls.push({ ms: Date.now() - started, finishReason: "", parsed: false, hardOk: false, error: toRpcError(error).message });
    }
  }
  const last = calls.at(-1);
  throw Object.assign(
    new RpcFailure(rpcError("provider-error", last?.error ? `The webtoon planner failed: ${last.error}` : `The webtoon planner returned no usable storyboard (${images.min} to ${images.max} image panels).`, { retryable: true })),
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
        const panels = webtoonPanelTarget(req.source.length);
        planned = await plan(deps, buildPlannerPrompt({ roster: context.roster, source: req.source, panels }), webtoonPanelRange(panels), req.signal);
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
        const take = await drawPanel(deps, { request: requests[id]!, style, seed: "", chatId: req.chatId, characterId, config: req.config, signal: req.signal });
        await req.assertTarget();
        doc = await write((d) => {
          const p = d.panels[id]!;
          p.takes.push(take);
          p.selected = p.takes.length - 1;
          p.status = "done";
          delete p.error;
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
    req.onProgress({ stage: "committing", done: images.length - failed, total: images.length });
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

/** New take of one panel (random seed); the new take is selected (older takes stay, see `selectWebtoonTake`). */
export async function rerollWebtoonPanel(
  deps: WebtoonDeps,
  req: { chatId: string; historyId: string; panelId: string; config: InlayConfig; signal: AbortSignal; onChanged: () => void },
): Promise<WebtoonStripView> {
  const doc = await readStrip(deps.services.storage, req.chatId, req.historyId);
  const request = doc?.requests[req.panelId];
  if (!doc || !request || !doc.style) throw new RpcFailure(rpcError("not-found", "This webtoon panel has no image request.", { retryable: false }));
  const take = await drawPanel(deps, { request, style: doc.style, seed: "", chatId: req.chatId, characterId: doc.characterId, config: req.config, signal: req.signal });
  if (req.signal.aborted) throw aborted();
  const written = await updateStrip(deps.services.storage, req.chatId, req.historyId, (current) => {
    const d = current ?? doc;
    const p = d.panels[req.panelId] ?? { panelId: req.panelId, status: "pending" as const, takes: [], selected: -1 };
    p.takes.push(take);
    p.selected = p.takes.length - 1;
    p.status = "done";
    delete p.error;
    d.panels[req.panelId] = p;
    return d;
  }, deps.now);
  req.onChanged();
  return stripView(written);
}

/** Show another take of one panel (a previous reroll); the strip is laid out again with that image's size. */
export async function selectWebtoonTake(
  deps: WebtoonDeps,
  req: { chatId: string; historyId: string; panelId: string; take: number; width?: number },
): Promise<WebtoonStripView> {
  const written = await updateStrip(deps.services.storage, req.chatId, req.historyId, (current) => {
    const panel = current?.panels[req.panelId];
    if (!current || !panel?.takes[req.take]) throw new RpcFailure(rpcError("not-found", "This webtoon panel take does not exist.", { retryable: false }));
    panel.selected = req.take;
    return current;
  }, deps.now);
  return stripView(written, req.width);
}

/** Replace the text of one text item (the original text again removes the override). */
export async function editWebtoonText(
  deps: WebtoonDeps,
  req: { chatId: string; historyId: string; panelId: string; textIndex: number; text: string; width?: number },
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
    return current;
  }, deps.now);
  return stripView(written, req.width);
}
