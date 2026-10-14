// Fixtures: bun C:/Users/eme4/asset-maid-port/scratch/port-0.9.89.5/reslice/gen/engine/v5/gen-directions.mjs (ORIGINAL 0.9.89.5 bundle)
import { describe, expect, test } from "bun:test";
import fixture from "../__fixtures__/v5/directions.json";
import inputs from "../__fixtures__/v5/inputs.json";
import { buildV5AnalyzerRequest, resolveV5UserDirections } from "./analyzer";

/* eslint-disable @typescript-eslint/no-explicit-any */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("v5 image-ratio candidates (allowedSizeIds, custom sizes, fixed size)", () => {
  for (const c of fixture.cases as any[]) {
    test(c.name, () => {
      const directions = resolveV5UserDirections(c.run);
      expect(plain(directions)).toEqual(c.expected.directions);
      let request: unknown;
      try {
        const build = buildV5AnalyzerRequest({ context: inputs.context as any, userDirections: directions });
        const payload = build.request.payload as any;
        request = { ok: { sizes: payload.analyzer_catalog?.sizes, imageRatio: payload.user_directions?.image_ratio ?? null } };
      } catch (e) {
        request = { error: { message: (e as Error).message } };
      }
      expect(plain(request)).toEqual(c.expected.request);
    });
  }
});
