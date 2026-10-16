/**
 * Vision check of a stored webtoon panel (Jev 1.14 through the user's TypeSafe Decision connection; webtoon bench round 2,
 * `webtoon-bench2/scripts/images.py jev_check` / `identity_questions` / `drift` / `score`, without the outfit checks).
 * One request per panel image, sent by `image_id`: a presence noul and a face Box per visible character, plus the identity
 * nouls (anthro species; a single hair colour and glasses for humans). Face boxes go into the layout (balloons keep off them);
 * a failed identity check asks for one redraw with a new seed and boosted identity tags (`boostedRequest`).
 * Runs only when the host has `decision-images-v1` and a TypeSafe Decision connection is available; otherwise the strip keeps
 * the coordinate estimate. Errors never fail a panel: the caller gets null and the layout uses coordinates.
 */
import type { CutoutBox, InlayConfig, WebtoonPanelCheck } from "../../shared/contract/index.js";
import { isAbortLike, toRpcError } from "../rpc/errors.js";
import type { BackendServices, DecisionImageAnswer, DecisionImageQuestion } from "../services/types.js";
import { furryBaseTag, HAIR_COLOR, identityPrompt, isFurry, speciesName, type PanelRequest } from "./panel-request.js";
import type { ImagePanel, StoryCharacter } from "./storyboard-schema.js";

export const VISION_CAPABILITY = "decision-images-v1";
/** Box questions need Jev 1.14; `jev-latest` (still 1.13) rejects them with a generic 400. */
export const VISION_MODEL = "jev-1.14.0";
/** Face boxes below this confidence, or of a character the presence noul does not find, are ignored (coordinates for that character). */
export const FACE_MIN_CONFIDENCE = 0.3;
export const PRESENT_MIN = 0.2;
/** Identity thresholds, calibrated on bench round 1: human-with-ears panels scored 0.03-0.41 on species, anthro ones 0.65-0.90. */
const ID_THRESHOLD: Record<string, number> = { species: 0.5 };
const ID_THRESHOLD_DEFAULT = 0.3;
/** The redraw adds this to the identity weights (and takes a new seed). */
export const ID_BOOST = 0.25;
/** No face for these framings (the layout has no head estimate for them either), and no identity check. */
const NO_FACE = new Set(["hands only", "lower body"]);
const ASSET = "panel";

/** Cast member as the strip document stores it (older documents have no gender / identity). */
export interface CastIdentity { name: string; gender?: string; identity?: string }

/** Decision connection for the check, or null (no capability, no TypeSafe connection): the extension's Decision connection, else the default one. */
export async function visionConnection(services: BackendServices, config: InlayConfig): Promise<string | null> {
  if (!((services.host.host?.capabilities?.[VISION_CAPABILITY] ?? 0) >= 1)) return null;
  const list = await services.decisions.listConnections();
  const chosen = config.jevConnection.connectionId;
  const candidates = [chosen ? list.find((c) => c.id === chosen) : undefined, list.find((c) => c.isDefault)];
  return candidates.find((c) => c?.provider === "typesafe" && c.hasApiKey)?.id ?? null;
}

const tags = (s: string | undefined) => (s ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const WHERE: Record<string, string> = { "0.1": "at the far left", "0.3": "on the left", "0.5": "in the middle", "0.7": "on the right", "0.9": "at the far right" };

function describe(member: CastIdentity) {
  const noun = member.identity && isFurry(member.identity) ? "character" : member.gender === "female" ? "girl" : member.gender === "male" ? "man" : "character";
  const appearance = tags(member.identity)
    .filter((t) => t !== "female" && t !== "male" && !/\\\(|petite|short$|breasts|slender|stocky|build|waist|shoulders|skin$/u.test(t))
    .slice(0, 8)
    .join(", ");
  return { noun, named: `${noun} (${member.name})${appearance ? ` with ${appearance}` : ""}` };
}

/** Bench `identity_questions`: species for anthro characters; a single hair colour (two colours can't be checked one by one) and glasses for humans. */
function identityQuestions(member: CastIdentity, c: StoryCharacter, count: number, noun: string): Array<[string, string]> {
  if (!member.identity || NO_FACE.has(c.framing)) return [];
  const where = count > 1 ? WHERE[String(c.x)] ?? "" : "";
  const who = `the ${noun}${where ? ` ${where}` : ""}`;
  if (isFurry(member.identity)) {
    return [["species", `Is ${who} in \`image\` drawn as a furry anthropomorphic animal (${speciesName(member.identity)}) with a full animal head, a muzzle and fur over the whole body, rather than a human girl or man with animal ears?`]];
  }
  const out: Array<[string, string]> = [];
  const colours = tags(member.identity).filter((t) => HAIR_COLOR.test(t));
  if (colours.length === 1) out.push([`hair:${colours[0]}`, `Does ${who} in \`image\` have ${colours[0]}?`]);
  if (tags(member.identity).includes("glasses") && ["portrait", "upper body", "cowboy shot"].includes(c.framing)) out.push(["glasses", `Is ${who} in \`image\` wearing glasses?`]);
  return out;
}

interface PanelQuestions {
  questions: Record<string, DecisionImageQuestion>;
  faces: Array<{ name: string; face: string; present: string }>;
  identity: Array<{ name: string; check: string; key: string }>;
}

export function panelQuestions(panel: ImagePanel, cast: readonly CastIdentity[]): PanelQuestions {
  const members = new Map(cast.map((m) => [m.name, m]));
  const chars = panel.nai.characters.filter((c) => members.has(c.name));
  const out: PanelQuestions = { questions: {}, faces: [], identity: [] };
  chars.forEach((c, i) => {
    const member = members.get(c.name)!;
    const { noun, named } = describe(member);
    if (!NO_FACE.has(c.framing)) {
      out.questions[`present${i}`] = { type: "noul", instructions: `Is there a ${named} in \`image\`?` };
      out.questions[`face${i}`] = { type: "box", instructions: `the face of the ${named} in \`image\`` };
      out.faces.push({ name: c.name, face: `face${i}`, present: `present${i}` });
    }
    identityQuestions(member, c, chars.length, noun).forEach(([check, text], j) => {
      out.questions[`id${i}_${j}`] = { type: "noul", instructions: text };
      out.identity.push({ name: c.name, check, key: `id${i}_${j}` });
    });
  });
  return out;
}

const threshold = (check: string) => ID_THRESHOLD[check] ?? ID_THRESHOLD_DEFAULT;

export function readPanelCheck(q: PanelQuestions, model: string, answers: Record<string, DecisionImageAnswer | undefined>): WebtoonPanelCheck {
  const noul = (key: string) => {
    const a = answers[key];
    return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : null;
  };
  const faces: Record<string, CutoutBox> = {};
  for (const f of q.faces) {
    const a = answers[f.face];
    if (a?.type !== "box" || a.confidence < FACE_MIN_CONFIDENCE || (noul(f.present) ?? 0) < PRESENT_MIN) continue;
    const { left, top, right, bottom } = a.box;
    faces[f.name] = { left, top, right, bottom };
  }
  const identity = q.identity.flatMap((d) => {
    const v = noul(d.key);
    return v === null ? [] : [{ name: d.name, check: d.check, noul: v }];
  });
  const margins = identity.map((d) => d.noul - threshold(d.check));
  return {
    model,
    faces,
    identity,
    score: margins.length ? Math.min(...margins) : 1,
    failed: identity.filter((d) => d.noul < threshold(d.check)).map((d) => `${d.name}: ${d.check} (${d.noul.toFixed(2)})`),
  };
}

/** One check of a stored panel image. Null when there is nothing to ask or on any error (logged; the layout uses coordinates). */
export async function checkPanel(
  services: BackendServices,
  input: { connectionId: string; imageId: string; panel: ImagePanel; cast: readonly CastIdentity[]; signal: AbortSignal },
): Promise<WebtoonPanelCheck | null> {
  const q = panelQuestions(input.panel, input.cast);
  if (!Object.keys(q.questions).length) return null;
  try {
    const res = await services.decisions.evaluateImages(
      { connection_id: input.connectionId, model: VISION_MODEL, state: { image: ASSET }, questions: q.questions, assets: { [ASSET]: { image_id: input.imageId } } },
      { signal: input.signal },
    );
    return readPanelCheck(q, res.model, res.answers);
  } catch (error) {
    if (!input.signal.aborted && !isAbortLike(error))
      services.log.append("warn", "webtoon", `Panel ${input.panel.id}: vision check failed, balloons placed by coordinates`, { error: toRpcError(error).message });
    return null;
  }
}

/** The redraw's request: identity weights + ID_BOOST in the character prompts, the cut-out's prompts and the anthro species tag of the base. */
export function boostedRequest(request: PanelRequest, cast: readonly CastIdentity[]): PanelRequest {
  const members = new Map(cast.map((m) => [m.name, { gender: m.gender ?? "", identity: m.identity ?? "" }]));
  const swap = (prompt: string, name: string) => {
    const m = members.get(name);
    if (!m?.identity) return prompt;
    const from = identityPrompt(m);
    return prompt.startsWith(from) ? identityPrompt(m, ID_BOOST) + prompt.slice(from.length) : prompt;
  };
  const visible = request.characters.flatMap((c) => members.get(c.name) ?? []);
  const species = visible.length === request.characters.length ? furryBaseTag(visible) : "";
  const base = (prompt: string) => (species ? prompt.replace(species, furryBaseTag(visible, ID_BOOST)) : prompt);
  return {
    ...request,
    prompt: base(request.prompt),
    characters: request.characters.map((c) => ({ ...c, prompt: swap(c.prompt, c.name) })),
    ...(request.cutout ? { cutout: { prompt: base(request.cutout.prompt), characters: request.cutout.characters.map((p, i) => swap(p, request.characters[i]?.name ?? "")) } } : {}),
  };
}
