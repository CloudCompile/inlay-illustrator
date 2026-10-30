/**
 * Provider-aware request shaping for the "generic" Lumiverse image providers (everything that is not NovelAI or
 * ComfyUI: OpenAI, Google Gemini/Imagen, SwarmUI, sdapi, ...).
 *
 * The engine treats every generic provider as "chan-server" (anima-flat codec, tags only), but the host forwards our
 * `parameters` object verbatim to the provider. Providers disagree about what they accept:
 *
 * - OpenAI (`gpt-image-*`, `dall-e-*`) rejects sampling controls, seeds and negative prompts, and only accepts a fixed
 *   set of `size` values, so an anima-flat request with `(tag:1.2)` weights, a seed and a negative prompt fails.
 * - Gemini/Imagen likewise take a natural-language prompt with no negative prompt or seed.
 * - SwarmUI / sdapi are Stable-Diffusion-style and keep the tags, weights, seed and negative prompt.
 *
 * This module classifies the connection into a {@link ImageProviderFamily} and rewrites the parameters (and prompt
 * text) to match, so OpenAI-class models work without changing the shared engine.
 */

export type ImageProviderFamily = "openai" | "gemini" | "novelai" | "comfy-ui" | "swarmui" | "generic";

/** Parameter keys that only make sense for a diffusion backend (never sent to OpenAI/Gemini). */
const DIFFUSION_ONLY_KEYS: readonly string[] = Object.freeze([
  "seed", "steps", "cfg", "cfg_scale", "scale", "guidance", "sampler", "sampler_name", "scheduler",
  "noise_schedule", "cfg_rescale", "qualityToggle", "resolution", "negativePrompt", "negative_prompt",
  "characterTags", "resolvedReferenceImages", "resolvedSourceImages", "referenceFidelity", "denoise",
  "workflow", "workflow_id", "workflowFormat", "preserveImportedWorkflow", "comfyui_field_values", "rawRequestOverride",
]);

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

/** True for families that take a natural-language prompt (no attention weights, no negative prompt, no seed). */
export function isTextDrivenFamily(family: ImageProviderFamily): boolean {
  return family === "openai" || family === "gemini";
}

/** True for families that reject a negative prompt. */
export function familySupportsNegativePrompt(family: ImageProviderFamily): boolean {
  return !isTextDrivenFamily(family);
}

/** True for families that accept an explicit seed. */
export function familySupportsSeed(family: ImageProviderFamily): boolean {
  return !isTextDrivenFamily(family);
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
  /** Resolved reference images (data URLs / base64) when the provider takes one. */
  references?: Array<{ data: string; mimeType: string }>;
  /** Parameter name discovered from the provider schema for reference images (e.g. `image`). */
  referenceParameter?: string;
}

/**
 * Build the `parameters` object for a generic connection, shaped for its family. Diffusion families get width/height/
 * seed/negative; OpenAI and Gemini get only what they accept (plus `size` for OpenAI).
 */
export function buildGenericProviderParameters(family: ImageProviderFamily, input: GenericParameterInput): Record<string, unknown> {
  const parameters: Record<string, unknown> = { ...input.base };
  if (isTextDrivenFamily(family)) for (const key of DIFFUSION_ONLY_KEYS) delete parameters[key];
  if (family === "openai") {
    if (parameters.size === undefined) parameters.size = openAiImageSize(input.width, input.height, input.model);
  } else if (!isTextDrivenFamily(family)) {
    parameters.width = input.width;
    parameters.height = input.height;
  }
  const referenceParameter = String(input.referenceParameter ?? "").trim();
  if (referenceParameter && input.references?.length) {
    parameters[referenceParameter] = input.references.map((r) => r.data);
  }
  return parameters;
}
