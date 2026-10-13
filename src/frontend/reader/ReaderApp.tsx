/**
 * Webtoon reader (classic white reading view): the active chat as one vertical column of its pages (selected entry per slot, slot order), messages
 * without pages as quiet text cards, and a per-message "show text" toggle under the pages. Opens at the start of the
 * latest message and re-reads the chat on `chatData.changed` (new or regenerated pages appear while open).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ReaderMessage, ReaderPage } from "../../shared/contract/chat-dom.js";
import { IconButton, XIcon, cn } from "../overlay/ui/index.js";
import type { AppController } from "../state/app-state.js";
import { useSelector } from "../state/store.js";
import type { ZoomTarget } from "../zoom/session.js";
import { fill, READER_LABELS as L } from "./labels.js";
import { readerParagraphs } from "./model.js";

export interface ReaderAppProps {
  app: AppController;
  chatId: string;
  onClose: () => void;
  openZoom: (target: ZoomTarget) => void;
}

export function ReaderApp({ app, chatId, onClose, openZoom }: ReaderAppProps) {
  const [messages, setMessages] = useState<ReaderMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [textOpen, setTextOpen] = useState<ReadonlySet<string>>(new Set());
  const revision = useSelector(app.store, (s) => s.chatDataRevision[chatId] ?? 0);
  const title = useSelector(app.store, (s) => s.characters?.find((c) => c.characterId === s.status?.activeCharacterId)?.name ?? L.dialog);
  const scroller = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);

  const load = () => {
    app.call("reader.getChat", { chatId }).then(
      (result) => {
        setMessages(result.messages);
        setFailed(false);
      },
      () => setFailed(true)
    );
  };
  useEffect(load, [chatId, revision]);

  // First render with data: start at the latest message.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages?.length || positioned.current) return;
    positioned.current = true;
    const last = el.querySelector<HTMLElement>("[data-ii-reader-message]:last-of-type");
    if (last) el.scrollTop = last.offsetTop;
  }, [messages]);

  const toggleText = (key: string) =>
    setTextOpen((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div class="flex h-full min-h-0 flex-col bg-white text-[#1d1d1f]" data-ii-reader="">
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.08] bg-white pl-4 pr-1.5">
        <h2 class="min-w-0 flex-1 truncate text-sm font-bold">{title}</h2>
        <IconButton label={L.close} className="text-black/60 hover:bg-black/[0.06] hover:text-black" onClick={onClose} data-ii-reader-close=""><XIcon className="size-5" /></IconButton>
      </header>
      <div ref={scroller} class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" data-ii-reader-scroll="">
        {failed && !messages ? (
          <p class="flex flex-col items-center gap-3 px-6 py-24 text-center text-sm text-black/50">
            {L.loadFailed}
            <button type="button" class="cursor-pointer rounded-md bg-black/[0.06] px-3 py-1.5 text-xs font-bold text-black/75 hover:bg-black/[0.1]" onClick={load}>{L.retry}</button>
          </p>
        ) : messages && messages.length === 0 ? (
          <p class="px-6 py-24 text-center text-sm text-black/50">{L.empty}</p>
        ) : (
          <div class="mx-auto flex w-full max-w-[720px] flex-col gap-16 pb-[30vh] pt-8 mobile:gap-12 mobile:pt-4">
            {(messages ?? []).map((message) => (
              <article key={message.messageKey} data-ii-reader-message={message.messageId}>
                {message.pages.length ? (
                  <>
                    <div class="flex flex-col gap-1">
                      {message.pages.map((page, index) => (
                        <Page key={page.slotId} page={page} label={fill(L.openPage, { n: index + 1 })} onOpen={() => openZoom({ chatId, slotId: page.slotId, entryId: page.entryId, messageKey: message.messageKey })} />
                      ))}
                    </div>
                    {message.text ? (
                      <div class="flex flex-col items-center gap-3 pt-2">
                        <button
                          type="button"
                          class="cursor-pointer rounded-full px-3 py-1 text-xs font-semibold text-black/40 transition-colors hover:bg-black/[0.05] hover:text-black/70"
                          aria-expanded={textOpen.has(message.messageKey)}
                          onClick={() => toggleText(message.messageKey)}
                          data-ii-reader-text-toggle=""
                        >
                          {textOpen.has(message.messageKey) ? L.hideText : L.showText}
                        </button>
                        {textOpen.has(message.messageKey) ? <TextCard message={message} /> : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <TextCard message={message} />
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Page({ page, label, onOpen }: { page: ReaderPage; label: string; onOpen: () => void }) {
  // The aspect ratio reserves the page height before the image loads, so lazy loading never moves the scroll position.
  return (
    <button type="button" class="block w-full cursor-zoom-in bg-black/[0.04] p-0" style={{ aspectRatio: `${page.width} / ${page.height}` }} aria-label={label} onClick={onOpen} data-ii-reader-page={page.slotId}>
      <img class="block h-full w-full object-contain" src={page.url} width={page.width} height={page.height} loading="lazy" decoding="async" alt="" draggable={false} />
    </button>
  );
}

function TextCard({ message }: { message: ReaderMessage }) {
  const user = message.role === "user";
  return (
    <div class={cn("flex w-full px-4 mobile:px-3", user ? "justify-end" : "justify-center")} data-ii-reader-text={user ? "user" : "character"}>
      <div class={cn("flex flex-col gap-3 rounded-2xl px-5 py-4 text-[0.95rem] leading-7 mobile:px-4", user ? "max-w-[min(85%,560px)] bg-[#e9f0fd] text-[#1f2a44]" : "w-full max-w-[640px] bg-[#f4f4f5] text-[#2a2a2d]")}>
        {message.name ? <p class={cn("-mb-1.5 text-2xs font-bold uppercase tracking-wider", user ? "text-[#3b5bdb]" : "text-black/45")}>{message.name}</p> : null}
        {readerParagraphs(message.text).map((runs, i) => (
          <p key={i} class="whitespace-pre-line">
            {runs.map((run, j) => (run.emphasis ? <em key={j} class="text-black/50">{run.text}</em> : run.text))}
          </p>
        ))}
      </div>
    </div>
  );
}
