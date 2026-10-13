import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { RpcClient } from "../rpc/client.js";
import { AppController } from "../state/app-state.js";
import { createFakeSpindleContext } from "../dev/fake-context.js";
import { createFullMockBackend } from "../dev/mock/index.js";
import { mockChat } from "../dev/mock/chat.js";
import type { ZoomTarget } from "../zoom/session.js";
import { createWebtoonReader } from "./index.js";

// Private happy-dom window (other test files install DOM fakes on globalThis).
const win = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const doc = win.document as unknown as Document;
afterAll(() => win.happyDOM.abort());

async function until<T>(read: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("webtoon reader (DOM, dev mock)", () => {
  test("shows pages in chat and slot order, text cards, text toggle, zoom on tap, Escape closes", async () => {
    const mock = createFullMockBackend({ latencyMs: 0, timeScale: 0 });
    const fake = createFakeSpindleContext(doc, mock);
    const app = new AppController(new RpcClient(mock.transport, { clientId: "test" }));
    const opened: ZoomTarget[] = [];
    const reader = createWebtoonReader(fake.ctx, app, { doc, openZoom: (target) => opened.push(target) });
    const states: boolean[] = [];
    reader.subscribe((open) => states.push(open));
    const chat = mockChat(mock.db);

    reader.open(chat.chatId);
    await until(() => doc.querySelector("[data-ii-reader-page]"));
    const articles = [...doc.querySelectorAll("[data-ii-reader-message]")].map((a) => a.getAttribute("data-ii-reader-message"));
    expect(articles).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    // msg-2: active revision rev-2b, slot 0 shows its selected entry (the 2nd of 3), then slot 1.
    const slot0 = chat.messages[1]!.revisions[1]!.slots[0]!;
    const pages = [...doc.querySelectorAll('[data-ii-reader-message="msg-2"] [data-ii-reader-page]')];
    expect(pages.map((p) => p.getAttribute("data-ii-reader-page"))).toEqual(["illustration:msg-2@0:slot:0", "illustration:msg-2@0:slot:1"]);
    expect(pages[0]!.querySelector("img")!.getAttribute("src")).toBe(slot0.entries.find((e) => e.entryId === slot0.selectedEntryId)!.url);
    expect((pages[1] as HTMLElement).style.aspectRatio).toBe("1216 / 832");
    // Messages without pages are text cards; user and character cards differ.
    expect(doc.querySelector('[data-ii-reader-message="msg-1"] [data-ii-reader-text]')?.getAttribute("data-ii-reader-text")).toBe("user");
    expect(doc.querySelector('[data-ii-reader-message="msg-4"] [data-ii-reader-text]')?.getAttribute("data-ii-reader-text")).toBe("character");

    // The text of an illustrated message is hidden until toggled.
    expect(doc.querySelector('[data-ii-reader-message="msg-2"] [data-ii-reader-text]')).toBeNull();
    (doc.querySelector('[data-ii-reader-message="msg-2"] [data-ii-reader-text-toggle]') as HTMLElement).click();
    const text = await until(() => doc.querySelector('[data-ii-reader-message="msg-2"] [data-ii-reader-text]'));
    expect(text.textContent).toContain("Seo-yeon looks up");

    (pages[1] as HTMLElement).click();
    expect(opened).toEqual([{ chatId: chat.chatId, slotId: "illustration:msg-2@0:slot:1", entryId: chat.messages[1]!.revisions[1]!.slots[1]!.selectedEntryId, messageKey: "illustration:msg-2@0" }]);

    // Live update: another entry selected elsewhere -> chatData.changed -> the page shows it.
    const other = slot0.entries.find((e) => e.entryId !== slot0.selectedEntryId)!;
    await app.call("history.selectEntry", { chatId: chat.chatId, slotId: slot0.slotId, entryId: other.entryId });
    await until(() => doc.querySelector(`[data-ii-reader-page="${slot0.slotId}"] img`)?.getAttribute("src") === other.url);

    const root = doc.querySelector(".ii-am-reader") as HTMLElement;
    root.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    expect(reader.isOpen()).toBeFalse();
    expect(root.style.display).toBe("none");
    expect(states).toEqual([true, false]);

    reader.destroy();
    app.destroy();
  });
});
