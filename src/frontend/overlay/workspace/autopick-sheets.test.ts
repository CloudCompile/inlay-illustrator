import { describe, expect, test } from "bun:test";
import { autoPickGroupId, type AutoPickGroup } from "../../../shared/contract/autopick.js";
import { normalizeAssetRef } from "../../../shared/contract/character.js";
import { planSheets, tileUrl } from "./autopick-sheets.js";

function group(promptKey: string, outfit: string, extra: Partial<AutoPickGroup> = {}): AutoPickGroup {
  const candidates = [0, 1, 2].map((i) => ({ asset: normalizeAssetRef({ name: `${outfit}_${i}.webp`, key: `${outfit}-${i}`, extension: "webp" }), name: `${outfit}_${i}`, url: `/api/v1/images/${outfit}-${i}`, thumbnailUrl: `/api/v1/images/${outfit}-${i}?size=sm` }));
  return { id: autoPickGroupId(promptKey, outfit), promptKey, characterToken: promptKey, outfit, nude: false, assetCount: 3, candidates, ...extra };
}

describe("auto-pick contact sheets", () => {
  test("untagged groups of the chosen characters, 25 tiles per sheet and 4 sheets per job", () => {
    const many = Array.from({ length: 130 }, (_, i) => group("a", `o${i}`));
    const others = [group("b", "x"), group("", "lost"), group("a", "done", { tags: {} as AutoPickGroup["tags"] })];
    const jobs = planSheets([...many, ...others], new Set(["a"]), () => 0);
    expect(jobs.map((job) => job.map((sheet) => sheet.length))).toEqual([[25, 25, 25, 25], [25, 5]]);
    expect(jobs.flat(2).some((t) => t.groupId === others[2]!.id || t.groupId === others[1]!.id || t.groupId === others[0]!.id)).toBe(false);
  });

  test("the chosen candidate is tiled from the 700 px thumbnail", () => {
    const jobs = planSheets([group("a", "o")], new Set(["a"]), () => 7);
    expect(jobs[0]![0]![0]).toEqual({ groupId: autoPickGroupId("a", "o"), candidate: 2, url: "/api/v1/images/o-2?size=lg" });
    expect(tileUrl({ asset: normalizeAssetRef({ name: "x", key: "x" }), name: "x", url: "/img/x", thumbnailUrl: "" })).toBe("/img/x");
  });
});
