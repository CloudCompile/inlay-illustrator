import { describe, expect, test } from "bun:test";
import { chosenOutfits, type PlannerRosterEntry } from "./planner-prompt.js";
import type { ImagePanel } from "./storyboard-schema.js";
import { buildQuoteIndex, checkQuote, hardOk, validateStoryboard } from "./storyboard-validate.js";

const SOURCE = [
  "Natsuki tugged the strap of her tote bag. \u201cFinally, jeez. Took you so long.\u201d",
  "\u201cNo,\u201d Natsuki said, looking away. \u201cI was... at the library.\u201d",
  "Jay laughed. \u201cI know where my street is!\u201d",
].join("\n\n");

const image = (id: number, extra: Record<string, unknown> = {}) => ({
  id, kind: "image", beat: "dialogue", size: "832x1216", layout: "full_width", nai: { base: "upper body, street", characters: [] }, text: [], ...extra,
});
const ROSTER = [
  { name: "Natsuki", gender: "female", formLabel: "pink hair", outfitLabel: "Uniform", outfit: { top: "gray blazer", legs: "black thighhighs", feet: "white uwabaki slippers" } },
  { name: "Jay", gender: "male", formLabel: "brown hair", outfitLabel: "Suit", outfit: { top: "black jacket" } },
];

describe("webtoon storyboard validation (round 2)", () => {
  test("hard rule: 6 to 8 image panels with a base prompt", () => {
    expect(hardOk({ panels: [1, 2, 3, 4, 5].map((i) => image(i)) })).toBe(false);
    expect(hardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i)) })).toBe(true);
    expect(hardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i, i === 3 ? { nai: { base: "" } } : {})) })).toBe(false);
    expect(hardOk("not json")).toBe(false);
  });

  test("quotes: verbatim kept, joined across a speech tag, near match repaired, invented dropped", () => {
    const idx = buildQuoteIndex(SOURCE);
    expect(checkQuote("Finally, jeez.", idx).text).toBe("Finally, jeez.");
    const joined = checkQuote("No, I was... at the library.", idx);
    expect(joined.text).toBe("No, I was... at the library.");
    expect(joined.notes.map((n) => n.kind)).toEqual(["joined"]);
    const repaired = checkQuote("Took you so long!", idx);
    expect(repaired.text).toBe("Took you so long!");
    expect(checkQuote("Your oven works, and mine is acting up.", idx).text).toBeNull();
  });

  test("repairs: unknown characters, columns, drop_outfit, balloon cap, text beat merge", () => {
    const raw = {
      title: "Chapter 2",
      panels: [
        image(1, {
          nai: {
            base: "cowboy shot, street",
            characters: [
              { name: "Natsuki", x: 0.52, y: 0.68, framing: "cowboy shot", prompt: "walking", drop_outfit: ["uwabaki slippers", "hat"] },
              { name: "Jay", x: 0.5, y: 0.7, framing: "bad", prompt: "laughing" },
              { name: "Ghost", x: 0.1, y: 0.1, framing: "portrait", prompt: "" },
            ],
          },
          text: [
            { type: "speech", speaker: "Natsuki", text: "Finally, jeez. Took you so long.", anchor: "top-left" },
            { type: "speech", speaker: "Jay", text: "Your oven works, and mine is acting up again.", anchor: "top" },
            { type: "speech", speaker: "Natsuki", text: "Finally, jeez.", anchor: "gutter-above" },
            { type: "speech", speaker: "Jay", text: "I know where my street is!", anchor: "right" },
          ],
        }),
        { id: 2, kind: "text_beat", beat: "quiet", layout: "text_on_white", text: [{ type: "narration", speaker: null, text: "Later.", anchor: "top-left" }] },
        image(3, { beat: "action", nai: { base: "full body", characters: [{ name: "Jay", x: 0.5, y: 0.7, framing: "full body", prompt: "running" }] } }),
        image(4), image(5), image(6),
      ],
    };
    const { storyboard, log, stats } = validateStoryboard(raw, ROSTER, SOURCE);
    const p1 = storyboard.panels[0] as ImagePanel;
    expect(p1.nai.characters.map((c) => [c.name, c.x, c.y, c.framing, c.drop_outfit])).toEqual([
      ["Natsuki", 0.5, 0.7, "cowboy shot", ["white uwabaki slippers"]],
      ["Jay", 0.7, 0.7, "upper body", []],
    ]);
    expect(p1.text.map((t) => [t.text, t.anchor])).toEqual([["Finally, jeez. Took you so long.", "top-left"], ["Finally, jeez.", "over-top-edge"]]);
    expect(stats.invented_dropped).toBe(1);
    expect(log.some((l) => l.includes('drop_outfit "hat" ignored'))).toBe(true);
    expect(storyboard.panels.map((p) => p.kind)).toEqual(["image", "image", "image", "image", "image"]);
    expect((storyboard.panels[1] as ImagePanel).text[0]!.text).toBe("Later.");
    expect(stats.sfx_missing_action).toBe(1);
  });

  test("Inlay outfit pick: known ids kept, unknown ids fall back to the current outfit", () => {
    const roster: PlannerRosterEntry[] = [
      { name: "Natsuki", gender: "female", formLabel: "", currentOutfitId: "school", outfits: [{ id: "school", label: "", outfit: {} }, { id: "casual", label: "", outfit: {} }] },
      { name: "Jay", gender: "male", formLabel: "", currentOutfitId: "suit", outfits: [{ id: "suit", label: "", outfit: {} }] },
    ];
    const log: string[] = [];
    expect(chosenOutfits({ outfits: [{ name: "Natsuki", outfit_id: "casual" }, { name: "Jay", outfit_id: "nope" }] }, roster, log)).toEqual({ Natsuki: "casual", Jay: "suit" });
    expect(log).toEqual(['Jay: unknown outfit "nope" -> suit']);
  });
});
