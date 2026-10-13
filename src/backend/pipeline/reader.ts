/**
 * Webtoon reader view of a chat (`reader.getChat`, pure): every message in chat order with its clean text and the
 * selected entry of each slot of the active revision, in slot order (slot index = paragraph gap = reading order).
 */
import { illustrationMessageKey, toHistoryMessageId, type ChatMessageUiState, type ReaderMessage, type ReaderPage } from "../../shared/contract/index.js";
import type { ChatMessageView } from "./host-chat.js";
import { cleanMessageContent } from "./markup.js";

export function readerPages(state: ChatMessageUiState): ReaderPage[] {
  return [...state.slots]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .flatMap((slot) => {
      const entry = slot.entries.find((e) => e.entryId === slot.selectedEntryId) ?? slot.entries.at(-1);
      return entry ? [{ slotId: slot.slotId, slotIndex: slot.slotIndex, entryId: entry.entryId, url: entry.url, width: entry.width, height: entry.height }] : [];
    });
}

/** Messages without pages and without text (e.g. a reply still streaming) are left out. */
export function readerMessages(views: readonly ChatMessageView[], states: readonly ChatMessageUiState[]): ReaderMessage[] {
  const stateById = new Map(states.map((s) => [s.messageId, s]));
  return views.flatMap((view) => {
    const state = stateById.get(view.id);
    const pages = state ? readerPages(state) : [];
    const text = cleanMessageContent(view.content).trim();
    if (!pages.length && !text) return [];
    return [{
      messageId: view.id,
      swipeIndex: view.swipeId,
      messageKey: illustrationMessageKey(toHistoryMessageId(view.id, view.swipeId)),
      role: view.role,
      name: view.name,
      text,
      pages,
    }];
  });
}
