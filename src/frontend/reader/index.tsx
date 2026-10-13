/**
 * Webtoon reader mount: its own body-level `.ii-am-root` layer (z-index 9994: above the overlay and the drawer, below
 * the zoom viewer so a tapped page opens on top of the reader). Escape closes it (capture phase, like the overlay).
 */
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { render } from "preact";
import { handleOverlayEscape } from "../overlay/escape.js";
import { LayerStack } from "../overlay/ui/index.js";
import { trackKeyboardInset } from "../overlay/viewport.js";
import type { AppController } from "../state/app-state.js";
import type { ZoomTarget } from "../zoom/session.js";
import { READER_LABELS } from "./labels.js";
import { ReaderApp } from "./ReaderApp.js";

export interface WebtoonReader {
  open(chatId: string): void;
  close(): void;
  isOpen(): boolean;
  subscribe(listener: (open: boolean) => void): () => void;
  destroy(): void;
}

export const READER_ROOT_CLASS = "ii-am-reader";

export function createWebtoonReader(ctx: SpindleFrontendContext, app: AppController, options: { openZoom: (target: ZoomTarget) => void; doc?: Document }): WebtoonReader {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const layers = new LayerStack();
  const listeners = new Set<(open: boolean) => void>();
  let root: HTMLElement | null = null;
  let stopInset: (() => void) | null = null;
  let chatId = "";
  let restoreFocus: HTMLElement | null = null;

  const onKeyDown = (event: KeyboardEvent) => {
    handleOverlayEscape(event, { open: !!chatId, root, layers, closeOverlay: () => reader.close() });
  };

  function ensureRoot(): HTMLElement {
    if (root) return root;
    try {
      root = ctx.dom.createElement("div");
    } catch {
      root = doc.createElement("div");
    }
    root.className = `ii-am-root ${READER_ROOT_CLASS}`;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", READER_LABELS.dialog);
    root.tabIndex = -1;
    root.style.cssText = [
      "position:fixed", "inset:0", "z-index:9994", "display:none", "flex-direction:column", "overflow:hidden",
      "width:var(--app-scaled-viewport-width,100vw)", "height:var(--app-scaled-viewport-height,100dvh)",
      "background:#ffffff",
      "padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) calc(env(safe-area-inset-bottom,0px) + var(--ii-am-keyboard-inset,0px)) env(safe-area-inset-left,0px)",
      "isolation:isolate"
    ].join(";");
    doc.body.appendChild(root);
    stopInset = trackKeyboardInset(root, win);
    return root;
  }

  function setOpen(next: string): void {
    chatId = next;
    for (const listener of [...listeners]) listener(!!chatId);
  }

  const reader: WebtoonReader = {
    open(next) {
      if (!next) return;
      const el = ensureRoot();
      if (!chatId) {
        restoreFocus = doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null;
        el.style.display = "flex";
        win.addEventListener("keydown", onKeyDown, true);
      }
      if (next !== chatId) {
        render(<ReaderApp key={next} app={app} chatId={next} onClose={() => reader.close()} openZoom={options.openZoom} />, el);
        setOpen(next);
      }
      el.focus({ preventScroll: true });
    },
    close() {
      if (!chatId || !root) return;
      win.removeEventListener("keydown", onKeyDown, true);
      render(null, root);
      root.style.display = "none";
      setOpen("");
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      restoreFocus = null;
    },
    isOpen: () => !!chatId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      reader.close();
      stopInset?.();
      root?.remove();
      root = null;
    }
  };
  return reader;
}
