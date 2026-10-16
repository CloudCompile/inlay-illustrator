import { describe, expect, test } from "bun:test";
import { checkQuote, sequenceRatio, splitLong, storyboardHardOk, validateStoryboard } from "./storyboard-schema.js";

const SOURCE = [
  "Natsuki tugged the strap of her tote bag. \u201cFinally, jeez. Took you so long.\u201d",
  "\u201cObviously. Why wouldn't I be?\u201d she said, and walked on.",
  "Jay laughed. \u201cI know where my street is!\u201d",
].join("\n\n");

const image = (id: number, extra: Record<string, unknown> = {}) => ({
  id, kind: "image", beat: "dialogue", size: "832x1216", layout: "full_width", nai: { base: "upper body, street", characters: [] }, text: [], ...extra,
});

describe("webtoon storyboard validation", () => {
  test("hard rule: 6 to 8 image panels with a base prompt", () => {
    expect(storyboardHardOk({ panels: [1, 2, 3, 4, 5].map((i) => image(i)) })).toBe(false);
    expect(storyboardHardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i)) })).toBe(true);
    expect(storyboardHardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i, i === 3 ? { nai: { base: "" } } : {})) })).toBe(false);
    expect(storyboardHardOk("not json")).toBe(false);
  });

  test("quotes: verbatim kept, near match replaced by the source words, invented dropped", () => {
    expect(checkQuote("Finally, jeez.", SOURCE).text).toBe("Finally, jeez.");
    const near = checkQuote("Obviously. Why would I not be?", SOURCE);
    expect(near.text).toBe("Obviously.");
    expect(near.notes.map((n) => n.kind)).toEqual(["dropped"]);
    const repaired = checkQuote("Took you so long!", SOURCE);
    expect(repaired.text).toBe("Took you so long!");
    expect(checkQuote("Your oven works, and mine is acting up.", SOURCE).text).toBeNull();
    expect(sequenceRatio(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(2 / 3);
  });

  test("repairs: unknown characters, same column, sizes, balloon caps, long lines, layout quota, outfits", () => {
    const raw = {
      title: "Chapter 2",
      outfits: { Natsuki: "casual", Jay: "nope" },
      panels: [
        image(1, {
          size: "999x999",
          nai: { base: "wide shot", characters: [{ name: "Natsuki", x: 0.52, y: 0.68, framing: "full body", prompt: "walking" }, { name: "Jay", x: 0.5, y: 0.7 }, { name: "Ghost", x: 0.1, y: 0.1 }] },
          text: [
            { type: "speech", speaker: "Natsuki", text: "Finally, jeez. Took you so long.", anchor: "top-left" },
            { type: "speech", speaker: "Jay", text: "Your oven works, and mine is acting up again.", anchor: "nowhere" },
            { type: "speech", speaker: "Natsuki", text: "Obviously.", anchor: "top-right" },
            { type: "speech", speaker: "Jay", text: "I know where my street is!", anchor: "right" },
          ],
        }),
        image(2, { beat: "action", text: [{ type: "narration", text: "One." }, { type: "narration", text: "Two." }] }),
        image(3, { size: "1472x704" }),
        image(4),
        image(5),
        image(6),
        { id: 7, kind: "text_beat", text: [{ type: "narration", text: "Later." }] },
      ],
    };
    const { storyboard, log, stats } = validateStoryboard(raw, { names: ["Natsuki", "Jay"], outfits: { Natsuki: ["school", "casual"], Jay: ["suit"] } }, SOURCE);
    const p1 = storyboard.panels[0]!;
    expect(p1.size).toBe("832x1216");
    expect(p1.nai.characters.map((c) => [c.name, c.x, c.y, c.framing])).toEqual([["Natsuki", 0.5, 0.7, "full body"], ["Jay", 0.7, 0.7, "upper body"]]);
    expect(p1.text.map((t) => t.text)).toEqual(["Finally, jeez. Took you so long.", "Obviously."]);
    expect(stats.inventedDropped).toBe(1);
    expect(stats.balloonsDropped).toBe(2); // "I know where..." over the cap + one narration of p2
    expect(storyboard.panels[1]!.text.length).toBe(1);
    expect(stats.sfxMissingAction).toBe(1);
    expect(storyboard.panels[2]!.layout).toBe("wide_band");
    expect(storyboard.panels.filter((p) => p.layout.startsWith("inset")).length).toBeGreaterThan(0);
    expect(stats.nonFullLayouts).toBeGreaterThanOrEqual(3);
    expect(storyboard.panels[6]!.layout).toBe("text_on_white");
    expect(storyboard.outfits).toEqual({ Natsuki: "casual", Jay: "suit" });
    expect(log.some((l) => l.includes('dropped unknown character "Ghost"'))).toBe(true);
    expect(log.some((l) => l.includes("Jay: unknown outfit"))).toBe(true);
  });

  test("a balloon over 12 words is split at a sentence end", () => {
    expect(splitLong("One two three four five six. Seven eight nine ten eleven twelve thirteen.")).toEqual(["One two three four five six.", "Seven eight nine ten eleven twelve thirteen."]);
    expect(splitLong("Short line.")).toEqual(["Short line."]);
  });
});
