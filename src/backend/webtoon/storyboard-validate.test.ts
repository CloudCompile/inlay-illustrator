import { describe, expect, test } from "bun:test";
import { chosenOutfits, webtoonPanelRange, webtoonPanelTarget, type PlannerRosterEntry } from "./planner-prompt.js";
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
  test("panel count: about one per 1,000 characters, 4 to 14, accepted within 2", () => {
    expect([800, 4400, 9600, 17346, 40000].map(webtoonPanelTarget)).toEqual([4, 4, 10, 14, 14]);
    expect([4, 10, 14].map(webtoonPanelRange)).toEqual([{ min: 4, max: 6 }, { min: 8, max: 12 }, { min: 12, max: 14 }]);
  });

  test("hard rule: image panel count in the accepted range, each with a base prompt", () => {
    const range = { min: 6, max: 8 };
    expect(hardOk({ panels: [1, 2, 3, 4, 5].map((i) => image(i)) }, range)).toBe(false);
    expect(hardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i)) }, range)).toBe(true);
    expect(hardOk({ panels: [1, 2, 3, 4, 5, 6].map((i) => image(i, i === 3 ? { nai: { base: "" } } : {})) }, range)).toBe(false);
    expect(hardOk("not json", range)).toBe(false);
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

  test("frame-break marks: kept on action panels with one character in a portrait panel, at most 2; none marked -> the first such panel", () => {
    const one = (name: string) => ({ base: "upper body, street", characters: [{ name, x: 0.5, y: 0.7, framing: "upper body", prompt: "running" }] });
    const fb = (raw: unknown[]) => validateStoryboard({ title: "T", panels: raw }, ROSTER, SOURCE).storyboard.panels.flatMap((p) => ((p as ImagePanel).frame_break ? [p.id] : []));
    const action = (id: number, extra: Record<string, unknown> = {}) => image(id, { beat: "action", nai: one("Natsuki"), ...extra });
    expect(fb([action(1, { frame_break: true }), action(2, { frame_break: true, nai: { ...one("Natsuki"), characters: [...one("Natsuki").characters, { ...one("Jay").characters[0]!, x: 0.9 }] } }), action(3, { frame_break: true }), action(4, { frame_break: true }), image(5, { frame_break: true, nai: one("Jay") })])).toEqual([1, 3]);
    expect(fb([image(1, { nai: one("Jay") }), action(2), action(3)])).toEqual([2]);
    expect(fb([image(1, { nai: one("Jay") })])).toEqual([]);
    const clamped = validateStoryboard({ title: "T", panels: [action(1, { frame_break: true })] }, ROSTER, SOURCE).storyboard.panels[0] as ImagePanel;
    expect(clamped.nai.characters[0]!.y).toBe(0.5);
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
