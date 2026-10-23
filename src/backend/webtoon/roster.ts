/**
 * Webtoon cast from the extension's character data: the analyzer context inputs (identity candidates of the
 * character's roster + the active persona, their forms and outfits; chat characters without an analysis join with their
 * appearance text or the look of the chat's latest strip, see looks.ts), the artist preset, negative prompt, NovelAI
 * parameters and outfit framing weights of the speaking character (same sources as `generate.ts`, no analyzer call).
 */
import {
  buildRuntimeConfig,
  chatKeyForChat,
  PERSONA_PROMPT_KEY_PREFIX,
  compileMainPrompt,
  type CharacterDocument,
  type ChatDataDocument,
  type ComicFormat,
  type InlayConfig,
} from "../../shared/contract/index.js";
import { mergeLocalLoreActorState, rebuildContinuityAtMessage, type ContinuityChatStore } from "../../engine/continuity/index.js";
import {
  buildAnalyzerContextInputs,
  buildKnownIdentities,
  resolveNovelAIRunConfig,
  resolveSourceGenerationSettings,
  withCustomCharacterMembers,
  type AssetMaidConfig,
  type CharacterSource,
  type IdentityCandidate,
  type PersonaRecord,
} from "../../engine/context/index.js";
import type { BackendServices, ChatInfo, PersonaInfo } from "../services/types.js";
import type { ChatMessageView } from "../pipeline/host-chat.js";
import { cleanMessageContent } from "../pipeline/markup.js";
import { continuityLookbackIds, speakingCharacterId } from "../pipeline/generate.js";
import { appearanceText, fold, latestLooks, type DerivedLook } from "./looks.js";
import type { PlannerRosterEntry } from "./planner-prompt.js";
import type { PlannerCharacter } from "./storyboard-schema.js";
import { dedupeTags, MANGA_NEGATIVE, WEBTOON_NEGATIVE, type OutfitPart, type WebtoonCastMember, type WebtoonStyle } from "./panel-request.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const PARTS: readonly OutfitPart[] = ["head", "top", "bottom", "legs", "feet"];

export interface RosterCharacter extends PlannerRosterEntry {
  key: string;
  identity: string;
}

export interface WebtoonContext {
  characterId: string;
  roster: RosterCharacter[];
  /** Free character generation on: the identities the planner's new characters must not repeat (AM knownIdentities). */
  knownIdentities: Array<{ name: string; keys: string[] }> | null;
  style: WebtoonStyle;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Whole-word, case-insensitive mention of a name or alias. */
export function mentions(text: string, names: readonly string[]): boolean {
  return names.some((n) => n.trim().length > 1 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text));
}

/** Roster entry of an identity candidate: default form, its outfits, the outfit worn last. */
export function rosterEntry(candidate: IdentityCandidate, currentOutfitId: string | undefined): RosterCharacter | null {
  const forms = candidate.appearanceForms ?? [];
  const form = forms.find((f) => f.formId === candidate.defaultFormId) ?? forms[0];
  if (!form) return null;
  const gender = str(form.gender) || str(candidate.gender);
  const outfits = (form.outfits ?? []).map((o): Rec & { id: string; label: string } => ({ ...rec(o), id: str(rec(o).outfitId ?? rec(o).id), label: str(o.label) })).filter((o) => o.id && PARTS.some((p) => str(o[p])));
  const ids = outfits.map((o) => o.id);
  const current = currentOutfitId && ids.includes(currentOutfitId) ? currentOutfitId : ids.includes(str(form.defaultOutfitId)) ? str(form.defaultOutfitId) : (ids[0] ?? "");
  const main = compileMainPrompt(form.basePromptGroups, gender);
  return {
    key: candidate.key,
    name: candidate.characterName.trim(),
    gender,
    formLabel: str(form.label),
    outfits: outfits.map((o) => ({ id: o.id, label: o.label, outfit: Object.fromEntries(PARTS.flatMap((p) => (str(o[p]) ? [[p, str(o[p])]] : []))) })),
    currentOutfitId: current,
    identity: [gender === "female" || gender === "male" ? gender : "", main].filter(Boolean).join(", "),
  };
}

/** Roster entry of a chat character with the look of an earlier strip (designed by the planner). */
function designedEntry(key: string, name: string, look: (DerivedLook & { gender: string; outfitId: string }) | undefined): RosterCharacter | null {
  if (!look?.identity) return null;
  const outfits = Object.values(look.outfit).some(Boolean) ? [{ id: look.outfitId || "look_1", label: look.outfitLabel, outfit: look.outfit }] : [];
  return { key, name, gender: look.gender, formLabel: "", outfits, currentOutfitId: outfits[0]?.id ?? "", identity: look.identity, designed: true };
}

/** Validator roster (round 2): the chosen outfit's label and items, for the `drop_outfit` check. */
export function validationRoster(roster: readonly RosterCharacter[], outfits: Record<string, string>): PlannerCharacter[] {
  return roster.map((r) => {
    const o = r.outfits.find((x) => x.id === (outfits[r.name] ?? r.currentOutfitId));
    return { name: r.name, gender: r.gender, formLabel: r.formLabel, outfitLabel: o?.label ?? "", outfit: o?.outfit ?? {} };
  });
}

/** Cast of the chosen outfits for the validated storyboard. */
export function castFor(roster: readonly RosterCharacter[], outfits: Record<string, string>): Map<string, WebtoonCastMember> {
  return new Map(
    roster.map((r) => {
      const outfitId = outfits[r.name] ?? r.currentOutfitId;
      return [r.name, { name: r.name, gender: r.gender, identity: r.identity, outfitId, outfit: r.outfits.find((o) => o.id === outfitId)?.outfit ?? {} }];
    }),
  );
}

function personaRecord(p: PersonaInfo): PersonaRecord {
  return { key: p.personaId, id: p.personaId, name: p.name, ...(p.avatarImageId ? { imageAsset: { key: p.avatarImageId, name: p.name, sourceType: "persona" } } : {}) };
}

export async function loadWebtoonContext(
  services: BackendServices,
  input: { chatId: string; chat: ChatInfo; messages: ChatMessageView[]; target: number; historyId: string; source: string; config: InlayConfig; chatData: ChatDataDocument; format?: ComicFormat },
): Promise<WebtoonContext> {
  const { config } = input;
  const view = input.messages[input.target];
  const primaryId = await speakingCharacterId(services, input.chat, view);
  const memberIds = [...new Set([primaryId, ...input.chat.groupCharacterIds].filter(Boolean))];
  const docs = new Map<string, CharacterDocument>();
  for (const id of memberIds) docs.set(id, await services.storage.loadCharacterDocument(id));
  const sources: CharacterSource[] = [];
  for (const id of memberIds) sources.push((await services.sources.buildSource(id, docs.get(id)!, { chatId: input.chatId })) as unknown as CharacterSource);
  const seen = new Set<string>();
  const source: CharacterSource = { ...sources[0]!, members: sources.flatMap((s) => s.members).filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true))) };
  const custom = [...docs.values()].flatMap((d) => d.customCharacters);
  const target = await services.images.resolveTarget();
  const runtime = buildRuntimeConfig(config, docs.get(primaryId) ?? null, { resolvedImageModel: target.model }) as unknown as Rec;
  const cp = rec(runtime.characterPrompt);
  const forms = { ...rec(cp.characterForms) };
  for (const id of memberIds.slice(1)) for (const [k, v] of Object.entries(rec(rec(docs.get(id)?.characterPrompt).characterForms))) if (!(k in forms)) forms[k] = v;
  runtime.characterPrompt = { ...cp, characterForms: forms };
  const amConfig = runtime as unknown as AssetMaidConfig;
  const character = await services.sources.getCharacter(primaryId);
  const personas = await services.sources.listPersonas();
  const active = await services.sources.getActivePersona(input.chatId);

  const chatKey = chatKeyForChat(input.chatId);
  const liveIds = continuityLookbackIds(input.messages, input.target, input.historyId);
  const continuity = rebuildContinuityAtMessage(input.chatData.store as unknown as ContinuityChatStore, chatKey, liveIds, input.historyId);
  continuity.characters[chatKey] = mergeLocalLoreActorState((continuity.characters[chatKey] ?? {}) as never, input.chatData.actorState as never) as never;
  const requestMessages = input.messages.slice(0, input.target).flatMap((m) => {
    const content = m.role === "system" ? "" : cleanMessageContent(m.content);
    return content.trim() ? [{ role: m.role === "assistant" ? "assistant" : "user", content }] : [];
  });
  const ft = buildAnalyzerContextInputs({
    config: amConfig,
    continuity: continuity as never,
    chatKey,
    messages: requestMessages,
    content: input.source,
    imageTokens: [],
    character: { name: character.name, description: character.description },
    source: withCustomCharacterMembers(source, custom as unknown[]),
    activePersona: active ? personaRecord(active) : null,
    personaRecords: personas.map(personaRecord),
  });

  const previous = new Map<string, string>();
  for (const ref of Object.values(ft.visualContinuity.previous_outfit_refs.actors)) if (ref?.lorebook_prompt_key && ref.outfit_id) previous.set(ref.lorebook_prompt_key, ref.outfit_id);
  const candidates = [...ft.analyzerIdentityCandidates, ...ft.analyzerPersonaCandidates];
  // A persona without an Inlay profile is no analysis (AM gives it a default form from its name).
  const personaProfiles = rec(config.characterPrompt.personaSettings.profiles);
  const all = candidates.flatMap((c) => {
    if (c.key.startsWith(PERSONA_PROMPT_KEY_PREFIX) && !personaProfiles[c.key.slice(PERSONA_PROMPT_KEY_PREFIX.length)]) return [];
    const entry = rosterEntry(c, previous.get(str(c.lorebookPromptKey) || c.key) ?? previous.get(c.key));
    return entry && entry.name ? [{ entry, names: [c.characterName, ...(c.aliases ?? [])] }] : [];
  });
  // Chat characters (card, group members, custom characters, persona) without an analysed look: the look of the chat's
  // latest strip, else the planner designs them from their appearance text. An analysis (same key or name) always wins.
  const looks = await latestLooks(services.storage, input.chatId);
  const analysedFor = (key: string, names: readonly string[]) => {
    const folded = new Set(names.map(fold).filter(Boolean));
    return all.find((a) => a.entry.key === key || a.entry.key.startsWith(`${key}::lore::asset-maid:charx-description`) || a.names.some((n) => folded.has(fold(n))));
  };
  const people: Array<{ key: string; names: string[]; description: string }> = [];
  for (const id of memberIds) {
    const info = id === primaryId ? character : await services.sources.getCharacter(id);
    people.push({ key: id, names: [info.name], description: info.description });
  }
  for (const c of custom) if (c.rosterRegistered !== false && c.workspaceEnabled !== false) people.push({ key: c.id, names: [c.title, ...c.recognitionKeys], description: c.appearanceDescription });
  if (active) people.push({ key: `${PERSONA_PROMPT_KEY_PREFIX}${active.personaId}`, names: [active.name], description: active.description });
  const pool = [...all];
  let primary: RosterCharacter | undefined;
  for (const p of people) {
    const name = p.names[0]!.trim();
    if (!name) continue;
    const analysed = analysedFor(p.key, p.names);
    const entry = analysed?.entry ?? designedEntry(p.key, name, looks.get(p.key)) ?? {
      key: p.key, name, gender: "", formLabel: "", outfits: [], currentOutfitId: "", identity: "",
      appearance: appearanceText(p.description, { char: name, user: active?.name ?? "" }),
    };
    if (p.key === primaryId) primary = entry;
    if (!analysed) pool.push({ entry, names: p.names });
  }
  // The speaking character is always in the roster; others when the reply names them.
  let roster = pool.filter((a) => mentions(input.source, a.names)).map((a) => a.entry);
  if (!roster.length) roster = all.filter((a) => a.entry.key.startsWith(primaryId)).map((a) => a.entry).slice(0, 1);
  if (primary) roster.unshift(primary);
  const names = new Set<string>();
  roster = roster.filter((r) => (names.has(fold(r.name)) ? false : (names.add(fold(r.name)), true)));

  const profile = str(rec(runtime.novelai).analysisProfile);
  const free = profile === "v5-hybrid" && resolveSourceGenerationSettings(amConfig, primaryId).freeCharacterGenerationEnabled;
  const knownIdentities = free ? buildKnownIdentities(withCustomCharacterMembers(source, custom as unknown[], "all"), personas.map(personaRecord)) : null;

  const prompts = ft.promptInputs({ actors: {} });
  const nai = resolveNovelAIRunConfig(amConfig, { sourceId: primaryId });
  const params: Rec = {};
  for (const key of ["sampler", "noiseSchedule", "steps", "scale", "cfgRescale", "qualityToggle"]) if (nai[key] !== undefined) params[key] = nai[key];
  return {
    characterId: primaryId,
    roster,
    knownIdentities,
    style: {
      style: [prompts.artistPrompt, prompts.fixedPositivePrompt].map(str).filter(Boolean).join(", "),
      negative: dedupeTags([prompts.artistNegativePrompt, prompts.negativePrompt, input.format === "manga" ? MANGA_NEGATIVE : WEBTOON_NEGATIVE].map(str).filter(Boolean).join(", ")),
      params,
      framingWeights: rec(cp.outfitPartFramingWeights) as WebtoonStyle["framingWeights"],
    },
  };
}
