import { describe, expect, test } from "bun:test";
import { isMonochromeStyle, stripColours } from "./manga-style.js";

describe("manga colour follows the artist style", () => {
  test("greyscale / monochrome with a positive weight", () => {
    const manga2 = "0.54::artist:kojima takeshi ::, year 2026, manga (style), -1::depth of field ::, 0.75::lineart ::, 1::greyscale ::, 0.75::monochrome ::, high complexity,\n\n1.25::redrawn ::";
    expect(isMonochromeStyle(manga2)).toBe(true);
    expect(isMonochromeStyle("artist:foo, monochrome, sketch")).toBe(true);
    expect(isMonochromeStyle("{{greyscale}}, 1.2::sketch ::")).toBe(true);
    expect(isMonochromeStyle("artist:foo, -1::greyscale ::, 0::monochrome ::")).toBe(false);
    expect(isMonochromeStyle("artist:foo, monochrome background, colorful")).toBe(false);
    expect(isMonochromeStyle("")).toBe(false);
  });

  test("colour words leave identity, outfit and scene text; black and white stay", () => {
    expect(stripColours("female, natsuki \\(doki doki literature club\\), 1.1::pink hair::, pink eyes, short hair, petite")).toBe("female, natsuki \\(doki doki literature club\\), short hair, petite");
    expect(stripColours("red hair ribbons, gray blazer, blue pleated skirt, 1.3::black thighhighs::, white shirt")).toBe("hair ribbons, blazer, pleated skirt, 1.3::black thighhighs::, white shirt");
    expect(stripColours("1.3::furry, light brown fur, anthro::, red-and-black jacket")).toBe("1.3::furry, fur, anthro::, black jacket");
    expect(stripColours("upper body, hallway, orange light\nShe stands in the orange hallway light, holding pink grid-paper.")).toBe("upper body, hallway, light\nShe stands in the hallway light, holding grid-paper.");
  });
});
