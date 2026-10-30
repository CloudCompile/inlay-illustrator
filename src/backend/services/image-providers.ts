/**
 * Provider-aware request shaping for the "generic" Lumiverse image providers (everything that is not NovelAI or
 * ComfyUI: OpenAI, Google Gemini/Imagen, Together, xAI, the OpenAI-compatible "custom" connection, SwarmUI, sdapi, ...).
 *
 * The engine treats every generic provider as "chan-server" (anima-flat codec, tags only), but the host forwards our
 * `parameters` object verbatim to the provider. Providers disagree about what they accept:
 *
 * - OpenAI (`gpt-image-*`, `dall-e-*`) rejects sampling controls, seeds and negative prompts, and only accepts a fixed
 *   set of `size` values, so an anima-flat request with `(tag:1.2)` weights, a seed and a negative prompt fails.
 * - Gemini/Imagen likewise take a natural-language prompt with no negative prompt or seed.
 * - SwarmUI / sdapi are Stable-Diffusion-style and keep the tags, weights, seed, negative prompt and width/height.
 * - OpenAI-compatible gateways (the `custom_openai` connection: Together, LiteLLM, WAN, reverse proxies, self-hosted
 *   gateways) are text-driven like OpenAI but read `size` (a "WxH" string), `seed`, `steps` and `negative_prompt`.
 *
 * Providers build their request body field-by-field and ignore keys they do not read, so we send a *superset* shaped
 * per family and let each provider pick what it understands, rather than trying to guess one exact schema.
 */

export type ImageProviderFamily = "openai" | "gemini" | "novelai" | "comfy-ui" | "swarmui" | "generic";

/** Parameter keys that only make sense for a diffusion backend (dropped for text-driven families). */
const DIFFUSION_ONLY_KEYS: readonly string[] = Object.freeze([
  "seed", "steps", "cfg", "cfg_scale", "scale", "guidance", "sampler", "sampler_name", "scheduler",
  "noise_schedule", "cfg_rescale", "qualityToggle", "resolution", "negativePrompt", "negative_prompt",
  "characterTags", "resolvedReferenceImages", "resolvedSourceImages", "referenceFidelity", "denoise",
  "workflow", "workflow_id", "workflowFormat", "preserveImportedWorkflow", "comfyui_field_values", "rawRequestOverride",
]);

/** How a family's provider expects the request to be shaped. */
interface FamilyShape {
  /** `size`: "snapped" = a supported OpenAI size, "exact" = the requested `WxH`, "none" = omit. */
  size: "snapped" | "exact" | "none";
  /** Send `width`/`height` (diffusion backends read these instead of `size`). */
  widthHeight: boolean;
  /** Add `negative_prompt` to the parameter bag (providers that read it from there). */
  negativePromptParam: boolean;
  /** Send an explicit `seed`. */
  seed: boolean;
  /** Keep diffusion-only keys (steps, cfg, sampler, ...) from the base parameters. */
  diffusionParams: boolean;
  /** Strip attention weights from the prompt (natural-language models render them as literal text). */
  stripWeights: boolean;
}

const FAMILY_SHAPES: Readonly<Record<ImageProviderFamily, FamilyShape>> = Object.freeze({
  openai: { size: "snapped", widthHeight: false, negativePromptParam: false, seed: false, diffusionParams: false, stripWeights: true },
  gemini: { size: "none", widthHeight: false, negativePromptParam: false, seed: false, diffusionParams: false, stripWeights: true },
  generic: { size: "exact", widthHeight: true, negativePromptParam: true, seed: true, diffusionParams: true, stripWeights: true },
  swarmui: { size: "none", widthHeight: true, negativePromptParam: true, seed: true, diffusionParams: true, stripWeights: false },
  novelai: { size: "none", widthHeight: false, negativePromptParam: true, seed: true, diffusionParams: true, stripWeights: false },
  "comfy-ui": { size: "none", widthHeight: false, negativePromptParam: true, seed: true, diffusionParams: true, stripWeights: false },
});

/** Classify a Lumiverse image-gen connection into a request-shaping family. */
export function imageProviderFamily(lumiverseProvider: unknown, model: unknown): ImageProviderFamily {
  const provider = String(lumiverseProvider ?? "").trim().toLowerCase();
  const modelText = String(model ?? "").trim().toLowerCase();
  const haystack = `${provider} ${modelText}`;
  if (provider === "novelai" || modelText.startsWith("nai-diffusion")) return "novelai";
  if (provider === "comfyui" || provider === "comfy-ui") return "comfy-ui";
  if (provider === "swarmui" || provider === "sdapi" || provider === "automatic1111" || provider === "a1111") return "swarmui";
  if (provider === "openai" || provider === "azure-openai" || /\bgpt-image\b|\bdall-e\b|\bdalle\b|\bgpt-image-\d/u.test(haystack)) return "openai";
  if (provider === "google" || provider === "google-gemini" || provider === "gemini" || provider === "imagen" || /imagen|\bgemini\b/u.test(haystack)) return "gemini";
  return "generic";
}

/** True when the prompt should have attention weights stripped (natural-language families). */
export function familyStripsWeights(family: ImageProviderFamily): boolean {
  return FAMILY_SHAPES[family].stripWeights;
}

/** True for families that read a negative prompt from the parameter bag. */
export function familySupportsNegativePrompt(family: ImageProviderFamily): boolean {
  return FAMILY_SHAPES[family].negativePromptParam;
}

/** True for families that accept an explicit seed. */
export function familySupportsSeed(family: ImageProviderFamily): boolean {
  return FAMILY_SHAPES[family].seed;
}

/** True for families whose provider can consume a reference/source image (`parameters.referenceImages`). */
export function familySupportsReferences(family: ImageProviderFamily): boolean {
  return family === "openai" || family === "gemini" || family === "generic" || family === "swarmui";
}

/** The supported `size` values of the OpenAI image API. */
const OPENAI_SIZES: readonly string[] = Object.freeze(["1024x1024", "1536x1024", "1024x1536"]);
/** DALL·E 3 uses a different (non-square-capable) size set. */
const DALLE3_SIZES: readonly string[] = Object.freeze(["1024x1024", "1792x1024", "1024x1792"]);

/** Closest supported OpenAI image size for a requested aspect ratio (landscape/portrait/square). */
export function openAiImageSize(width: unknown, height: unknown, model?: unknown): string {
  const w = Number(width);
  const h = Number(height);
  const sizes = /dall-e-3|\bdalle3\b/u.test(String(model ?? "").toLowerCase()) ? DALLE3_SIZES : OPENAI_SIZES;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return sizes[0]!;
  const ratio = w / h;
  if (ratio > 1.15) return sizes.find((s) => s !== "1024x1024" && Number(s.split("x")[0]) > Number(s.split("x")[1]))!;
  if (ratio < 0.87) return sizes.find((s) => Number(s.split("x")[0]) < Number(s.split("x")[1]))!;
  return "1024x1024";
}

/**
 * Removes attention/weight syntax (`(tag:1.2)`, `[tag:0.5]`, `tag::0.5`) and brace emphasis so text-driven models do
 * not render the weights as literal characters.
 */
export function stripPromptWeights(value: string): string {
  const weighted = /\(([^()]*?):\s*-?\d+(?:\.\d+)?\s*\)|\[([^\[\]]*?):\s*-?\d+(?:\.\d+)?\s*\]/u;
  let next = value;
  // Weight groups nest, so unwrap the innermost layer until none remain.
  while (weighted.test(next)) next = next.replace(new RegExp(weighted.source, "gu"), "$1$2");
  return next
    .replace(/\s*::\s*-?\d+(?:\.\d+)?/gu, "")
    .replace(/\s*::\s*/gu, ", ")
    .replace(/[{}]/gu, "")
    .replace(/\s*,\s*(?=,)/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export interface GenericParameterInput {
  /** Extra parameters merged into every request (`config.image.parameters`). */
  base: Record<string, unknown>;
  width: number;
  height: number;
  model: string;
  /** Resolved reference images (base64 + mime) attached as `parameters.referenceImages`. */
  references?: Array<{ data: string; mimeType: string }>;
}

/**
 * Build the `parameters` object for a generic connection, shaped for its family. A superset is produced: diffusion
 * families get `width`/`height`, text-driven families get a `size` string, and every family that can take one gets
 * `referenceImages`. Each host provider reads only the keys it knows and ignores the rest.
 */
export function buildGenericProviderParameters(family: ImageProviderFamily, input: GenericParameterInput): Record<string, unknown> {
  const shape = FAMILY_SHAPES[family];
  const parameters: Record<string, unknown> = { ...input.base };
  if (!shape.diffusionParams) for (const key of DIFFUSION_ONLY_KEYS) delete parameters[key];
  if (parameters.size === undefined) {
    if (shape.size === "snapped") parameters.size = openAiImageSize(input.width, input.height, input.model);
    else if (shape.size === "exact") parameters.size = `${input.width}x${input.height}`;
  }
  if (shape.widthHeight) {
    parameters.width = input.width;
    parameters.height = input.height;
  }
  if (input.references?.length) {
    parameters.referenceImages = input.references.map((r) => ({ data: r.data, mimeType: r.mimeType }));
  }
  return parameters;
}
