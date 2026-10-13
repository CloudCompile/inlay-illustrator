import { describe, expect, test } from "bun:test";
import { readerParagraphs } from "./model.js";

describe("readerParagraphs", () => {
  test("splits on blank lines, drops tags, marks *actions*", () => {
    expect(readerParagraphs('<div class="x">*She waves.* "Hi!"</div>\r\n\r\n  Second **bold** line\nwraps.\n\n\n')).toEqual([
      [{ text: "She waves.", emphasis: true }, { text: ' "Hi!"', emphasis: false }],
      [{ text: "Second ", emphasis: false }, { text: "bold", emphasis: true }, { text: " line\nwraps.", emphasis: false }]
    ]);
  });

  test("a lone asterisk stays text", () => {
    expect(readerParagraphs("5 * 3")).toEqual([[{ text: "5 * 3", emphasis: false }]]);
  });
});
