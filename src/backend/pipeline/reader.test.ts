import { describe, expect, test } from "bun:test";
import { renderIllustrationBlock, type ChatMessageUiState, type ChatSlotUi } from "../../shared/contract/index.js";
import { toMessageView } from "./host-chat.js";
import { readerMessages } from "./reader.js";

function slot(index: number, entryIds: string[], selected = entryIds.at(-1)!): ChatSlotUi {
  return {
    slotId: `illustration:m2@0:slot:${index}`,
    slotIndex: index,
    entries: entryIds.map((entryId, i) => ({ entryId, kind: "generated", assetName: entryId, imageId: entryId, url: `/img/${entryId}`, width: 832, height: 1216 + i, createdAt: i })),
    selectedEntryId: selected,
    canRegenerate: true,
    regenerating: false,
  };
}

function state(messageId: string, slots: ChatSlotUi[]): ChatMessageUiState {
  return { chatId: "c", messageId, swipeIndex: 0, messageKey: `illustration:${messageId}@0`, eligible: true, attempt: "reroll", planStatus: "complete", busy: false, revisions: [], activeRevisionId: "r", slots, allSlotsDeleted: false };
}

const block = renderIllustrationBlock({ chatId: "c", messageId: "m2", swipeId: 0, messageKey: "illustration:m2@0", revisionId: "r", slotId: "illustration:m2@0:slot:0", slotIndex: 0, entryId: "a", assetName: "a", imageId: "a", entryIndex: 1, entryCount: 1, canRegenerate: true, imageIndex: 0 });

describe("readerMessages", () => {
  test("chat order, pages in slot order with the selected entry, clean text", () => {
    const views = [
      toMessageView({ id: "m1", is_user: true, name: "Joon", content: "Hello?" }, 0)!,
      toMessageView({ id: "m2", name: "Seo-yeon", content: `First paragraph.\n\n${block}\n\nSecond paragraph.` }, 1)!,
      toMessageView({ id: "m3", name: "Seo-yeon", content: "No pictures here." }, 2)!,
    ];
    const messages = readerMessages(views, [state("m2", [slot(2, ["c"]), slot(0, ["a", "b"], "a")])]);
    expect(messages.map((m) => [m.messageId, m.role, m.name])).toEqual([["m1", "user", "Joon"], ["m2", "assistant", "Seo-yeon"], ["m3", "assistant", "Seo-yeon"]]);
    expect(messages[1]!.pages.map((p) => [p.slotIndex, p.entryId, p.url])).toEqual([[0, "a", "/img/a"], [2, "c", "/img/c"]]);
    expect(messages[1]!.text).not.toContain("inlay");
    expect(messages[1]!.text).toContain("Second paragraph.");
    expect(messages[1]!.messageKey).toBe("illustration:m2@0");
    expect(messages[2]!.pages).toEqual([]);
  });

  test("active swipe text; empty messages without pages are skipped; empty slots give no page", () => {
    const views = [
      toMessageView({ id: "m1", name: "A", swipes: ["old", "new"], swipe_id: 1, content: "new" }, 0)!,
      toMessageView({ id: "m2", name: "A", content: "  " }, 1)!,
    ];
    const messages = readerMessages(views, [state("m2", [slot(0, [])])]);
    expect(messages.map((m) => [m.messageId, m.swipeIndex, m.text])).toEqual([["m1", 1, "new"]]);
  });
});
