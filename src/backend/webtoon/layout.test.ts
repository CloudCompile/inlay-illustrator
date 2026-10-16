import { describe, expect, test } from "bun:test";
import type { LayoutInput } from "./layout";
import { layoutStrip } from "./layout";
import storyboardA from "./__fixtures__/storyboard-a.json" with { type: "json" };

const inputA = { storyboard: storyboardA, imageSizes: {} } as LayoutInput;

// webtoon-bench/html/strip-a.layout.json (Python layout.py, coordinates variant)
const BENCH_A = {
  height: 6731,
  kinds: [
    "speech", "speech", "narration", "speech", "thought", "speech", "speech", "speech", "narration",
    "narration", "sfx", "narration", "speech", "speech", "speech", "speech", "speech",
  ],
};

const overlaps = (a: number[], b: number[]) => Math.min(a[2]!, b[2]!) > Math.max(a[0]!, b[0]!) && Math.min(a[3]!, b[3]!) > Math.max(a[1]!, b[1]!);

describe("layoutStrip", () => {
  const out = layoutStrip(inputA);

  test("strip a lays out without fallbacks, overlapping balloons or out-of-order panels", () => {
    expect(out.items.filter((it) => it.fallback)).toEqual([]);
    const balloons = out.items.filter((it) => it.kind === "speech" || it.kind === "thought");
    for (const [i, a] of balloons.entries()) {
      for (const b of balloons.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
    expect(out.height).toBeGreaterThan(0);
    for (const [i, p] of out.panels.entries()) {
      expect(p.h).toBeGreaterThan(0);
      if (i > 0) expect(p.y).toBeGreaterThanOrEqual(out.panels[i - 1]!.y + out.panels[i - 1]!.h);
    }
    expect(out.panels.at(-1)!.y + out.panels.at(-1)!.h).toBeLessThanOrEqual(out.height);
  });

  test("matches the bench output of layout.py for strip a", () => {
    expect(out.items.map((it): string => it.kind)).toEqual(BENCH_A.kinds);
    expect(Math.abs(out.height - BENCH_A.height) / BENCH_A.height).toBeLessThan(0.05);
  });

  test("is deterministic", () => {
    expect(layoutStrip(structuredClone(inputA))).toEqual(out);
  });
});
