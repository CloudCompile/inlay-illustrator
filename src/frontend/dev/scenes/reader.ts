/**
 * Preview scenes of the webtoon reader. `samples=1` swaps the mock chat for a short story whose pages are
 * `./samples/1.png` .. `5.png` (832x1216): copy real pages into the preview dir by hand (dev only, never shipped).
 */
import { mockChat, mockEntry, slotIdOf, type MockChatMessage } from "../mock/chat.js";
import type { PreviewScene } from "../scenes.js";
import { clickWhenReady, waitFor } from "../scenes.js";

function storyMessages(): MockChatMessage[] {
  const page = (n: number) => ({ ...mockEntry("page", n), url: `./samples/${n}.png`, width: 832, height: 1216 });
  const withPages = (messageId: string, paragraphs: string[], pages: number[]): MockChatMessage => {
    const m = { messageId, swipeIndex: 0 };
    return {
      ...m,
      role: "assistant",
      name: "Natsuki",
      paragraphs,
      revisions: [{ revisionId: `rev-${messageId}`, createdAt: 0, status: "complete", deletedSlotIndices: [], slots: pages.map((n, i) => { const entry = page(n); return { slotId: slotIdOf(m, i), slotIndex: i, entries: [entry], selectedEntryId: entry.entryId }; }) }],
      activeRevisionId: `rev-${messageId}`,
      planStatus: "complete"
    };
  };
  const user = (messageId: string, text: string): MockChatMessage => ({ messageId, swipeIndex: 0, role: "user", name: "Haru", paragraphs: [text], revisions: [], activeRevisionId: "", planStatus: "idle" });
  return [
    user("s-1", "*I lean on the railing next to her on the way home.* You're quiet today. Something happen at the club?"),
    withPages("s-2", [
      "Natsuki stares at the pavement, gripping her bag with both hands. \"N-nothing happened. Why would anything happen?\"",
      "*You shrug and ask, loud enough for the whole street, whether she finally lost the baking contest.*",
      "She stomps the ground hard enough to rattle the pole. \"Don't just yell that out!\""
    ], [1, 3]),
    user("s-3", "Okay, okay. Come over, I'll make tea and you can tell me about it."),
    withPages("s-4", [
      "At your place she drops the bag on the table and starts unpacking: muffin trays, a cooling rack, a folded apron with pink frills.",
      "She freezes when she notices you leaning in the doorway. \"What are you staring at?!\"",
      "*You point out, very calmly, that you live here.*"
    ], [2, 4, 5]),
    user("s-5", "So... are you going to bake, or just glare at the oven?"),
    { messageId: "s-6", swipeIndex: 0, role: "assistant", name: "Natsuki", paragraphs: ["\"Bake, obviously.\" *She ties the apron with a sharp tug and points a whisk at you.* \"And you're helping. No complaining.\"", "The oven clicks on behind her with a soft hum."], revisions: [], activeRevisionId: "", planStatus: "idle" }
  ];
}

async function openReader(input: Parameters<PreviewScene>[0]): Promise<void> {
  const { mock, frontend, params, doc } = input;
  const chat = mockChat(mock.db);
  if (params.get("samples") === "1") chat.messages = storyMessages();
  frontend.reader.open(chat.chatId);
  await waitFor(doc, "[data-ii-reader-message]");
}

export const READER_SCENES: Record<string, PreviewScene> = {
  /** Opens at the latest message. */
  reader: openReader,
  /** Scrolled to the top of the chat. */
  "reader-top": async (input) => {
    await openReader(input);
    (await waitFor(input.doc, "[data-ii-reader-scroll]")).scrollTop = 0;
  },
  /** Text of the first illustrated message revealed, scrolled to it. */
  "reader-text": async (input) => {
    await openReader(input);
    const toggle = await clickWhenReady(input.doc, "[data-ii-reader-text-toggle]");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const scroller = await waitFor(input.doc, "[data-ii-reader-scroll]");
    scroller.scrollTop = toggle.offsetTop - 160;
  }
};
