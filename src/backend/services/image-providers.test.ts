import { describe, expect, test } from "bun:test";
import {
  buildGenericProviderParameters,
  familyStripsWeights,
  familySupportsNegativePrompt,
  familySupportsReferences,
  familySupportsSeed,
  imageProviderFamily,
  openAiImageSize,
  stripPromptWeights,
} from "./image-providers.js";

describe("imageProviderFamily", () => {
  test("classifies by provider id and model", () => {
    expect(imageProviderFamily("novelai", "nai-diffusion-4-5-full")).toBe("novelai");
    expect(imageProviderFamily("novelai", "")).toBe("novelai");
    expect(imageProviderFamily("comfyui", "wf")).toBe("comfy-ui");
    expect(imageProviderFamily("swarmui", "sd")).toBe("swarmui");
    expect(imageProviderFamily("sdapi", "anything")).toBe("swarmui");
    expect(imageProviderFamily("openai", "gpt-image-1")).toBe("openai");
    expect(imageProviderFamily("openai", "dall-e-3")).toBe("openai");
    expect(imageProviderFamily("azure-openai", "gpt-image-2.5")).toBe("openai");
    expect(imageProviderFamily("somewhere", "gpt-image-2.5")).toBe("openai");
    expect(imageProviderFamily("google-gemini", "imagen-3")).toBe("gemini");
    expect(imageProviderFamily("google", "gemini-2.5-flash-image")).toBe("gemini");
    expect(imageProviderFamily("unknown", "mystery")).toBe("generic");
  });

  test("OpenAI-compatible gateways stay generic and keep their parameters", () => {
    // `custom_openai` (Together, LiteLLM, WAN, reverse proxies) is a Lumiverse provider id, not an OpenAI family.
    expect(imageProviderFamily("custom_openai", "wan-2.6-image")).toBe("generic");
    expect(imageProviderFamily("custom_openai", "flux-1.1-pro")).toBe("generic");
    expect(familyStripsWeights("generic")).toBe(true);
    expect(familySupportsNegativePrompt("generic")).toBe(true);
    expect(familySupportsSeed("generic")).toBe(true);
    expect(familySupportsReferences("generic")).toBe(true);
  });

  test("text-driven families drop negatives and seeds", () => {
    expect(familyStripsWeights("openai")).toBe(true);
    expect(familyStripsWeights("gemini")).toBe(true);
    expect(familyStripsWeights("swarmui")).toBe(false);
    expect(familySupportsNegativePrompt("openai")).toBe(false);
    expect(familySupportsNegativePrompt("swarmui")).toBe(true);
    expect(familySupportsSeed("gemini")).toBe(false);
    expect(familySupportsSeed("swarmui")).toBe(true);
  });
});

describe("openAiImageSize", () => {
  test("maps aspect ratio onto the supported sizes", () => {
    expect(openAiImageSize(832, 1216)).toBe("1024x1536");
    expect(openAiImageSize(1216, 832)).toBe("1536x1024");
    expect(openAiImageSize(1024, 1024)).toBe("1024x1024");
    expect(openAiImageSize(1792, 1024, "dall-e-3")).toBe("1792x1024");
    expect(openAiImageSize(0, 0)).toBe("1024x1024");
  });
});

describe("stripPromptWeights", () => {
  test("removes attention weights and brace emphasis", () => {
    expect(stripPromptWeights("(red hair:1.2), blue eyes")).toBe("red hair, blue eyes");
    expect(stripPromptWeights("[hat:0.5]")).toBe("hat");
    expect(stripPromptWeights("cat::0.5, dog")).toBe("cat, dog");
    expect(stripPromptWeights("{glow}")).toBe("glow");
    expect(stripPromptWeights("((nested:1.3):1.1)")).toBe("nested");
    expect(stripPromptWeights("plain prompt")).toBe("plain prompt");
  });
});

describe("buildGenericProviderParameters", () => {
  test("OpenAI keeps only size and strips diffusion parameters", () => {
    const parameters = buildGenericProviderParameters("openai", {
      base: { seed: 5, steps: 30, cfg_scale: 7, sampler: "euler", negativePrompt: "bad", style: "vivid" },
      width: 832,
      height: 1216,
      model: "gpt-image-1",
    });
    expect(parameters).toEqual({ style: "vivid", size: "1024x1536" });
  });

  test("generic gateways get an exact size plus width/height and keep parameters", () => {
    const parameters = buildGenericProviderParameters("generic", {
      base: { seed: 5, steps: 30 },
      width: 832,
      height: 1216,
      model: "wan-2.6-image",
    });
    // `size` reaches OpenAI-compatible providers; `width`/`height` reach sdapi-style ones. Each ignores the other.
    expect(parameters).toEqual({ seed: 5, steps: 30, size: "832x1216", width: 832, height: 1216 });
  });

  test("diffusion families keep width/height and never get a size string", () => {
    const parameters = buildGenericProviderParameters("swarmui", {
      base: { seed: 5, steps: 30 },
      width: 832,
      height: 1216,
      model: "sd",
    });
    expect(parameters).toEqual({ seed: 5, steps: 30, width: 832, height: 1216 });
  });

  test("attaches references to parameters.referenceImages (the host's manual-only path)", () => {
    const parameters = buildGenericProviderParameters("openai", {
      base: {},
      width: 1024,
      height: 1024,
      model: "gpt-image-1",
      references: [{ data: "QUJD", mimeType: "image/png" }],
    });
    expect(parameters).toEqual({ size: "1024x1024", referenceImages: [{ data: "QUJD", mimeType: "image/png" }] });
  });

  test("no references -> no referenceImages key", () => {
    const parameters = buildGenericProviderParameters("openai", { base: {}, width: 1024, height: 1024, model: "gpt-image-1" });
    expect(parameters.referenceImages).toBeUndefined();
  });
});
