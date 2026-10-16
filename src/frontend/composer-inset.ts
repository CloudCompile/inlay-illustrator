/**
 * Composer inset: keeps our body-level layer (chat runtime host with the count panel and toasts) above the host
 * composer ([data-component="InputArea"]), whose height differs per layout (desktop ~110px, mobile ~100px + toolbar).
 *
 * Publishes `--ii-am-composer-inset` (CSS px in the body's coordinate space) on <html>. The host zooms <body> by
 * `--lumiverse-ui-scale` (Lumiverse frontend/src/theme/reset.css), and browsers differ in whether getBoundingClientRect
 * reports zoomed or unzoomed px. A fixed probe inside <body> (`bottom: 0; height: 100px`) calibrates both: its rect gives
 * the viewport bottom and the size of one CSS px in the same units as the composer rect.
 * Fallback (no composer, e.g. the home page): 66px.
 */

export const COMPOSER_INSET_VAR = "--ii-am-composer-inset";
export const COMPOSER_FALLBACK_INSET_PX = 66;
export const COMPOSER_GAP_PX = 12;
export const COMPOSER_SELECTOR = '[data-component="InputArea"]';
const PROBE_CSS_PX = 100;
const POLL_MS = 1000;

export interface ComposerMeasure {
  /** Viewport bottom in rect units (probe rect bottom). */
  viewportBottom: number;
  /** Rect units per CSS px inside <body> (probe rect height / 100). */
  unitPx: number;
  /** Composer rect top in rect units; null when there is no visible composer. */
  composerTop: number | null;
}

/** CSS px from the viewport bottom to just above the composer (+ gap). Pure. */
export function composerInsetPx(m: ComposerMeasure, gap = COMPOSER_GAP_PX, fallback = COMPOSER_FALLBACK_INSET_PX): number {
  if (m.composerTop === null || !(m.unitPx > 0) || !Number.isFinite(m.viewportBottom) || !Number.isFinite(m.composerTop)) return fallback;
  const inset = (m.viewportBottom - m.composerTop) / m.unitPx + gap;
  if (!Number.isFinite(inset)) return fallback;
  return Math.max(gap, Math.round(inset));
}

export interface ComposerInsetTracker {
  /** Current inset in CSS px. */
  current(): number;
  /** Re-measures now. */
  update(): void;
  stop(): void;
}

export function startComposerInset(doc: Document = document, win: Window & typeof globalThis = window): ComposerInsetTracker {
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("data-ii-composer-probe", "");
  probe.style.cssText = `position:fixed;left:0;bottom:0;width:0;height:${PROBE_CSS_PX}px;visibility:hidden;pointer-events:none;`;
  doc.body.appendChild(probe);
  let inset = COMPOSER_FALLBACK_INSET_PX;
  let observed: Element | null = null;
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => update()) : null;

  function measure(): ComposerMeasure {
    const p = probe.getBoundingClientRect();
    const composer = doc.querySelector(COMPOSER_SELECTOR);
    if (composer !== observed) {
      if (observed) resize?.unobserve(observed);
      if (composer) resize?.observe(composer);
      observed = composer;
    }
    const rect = composer?.getBoundingClientRect();
    const visible = !!rect && rect.height > 0 && rect.width > 0;
    return { viewportBottom: p.bottom, unitPx: p.height > 0 ? p.height / PROBE_CSS_PX : 1, composerTop: visible ? rect!.top : null };
  }

  function update(): void {
    const next = composerInsetPx(measure());
    if (next === inset && doc.documentElement.style.getPropertyValue(COMPOSER_INSET_VAR)) return;
    inset = next;
    doc.documentElement.style.setProperty(COMPOSER_INSET_VAR, `${inset}px`);
  }

  const onResize = () => update();
  win.addEventListener("resize", onResize);
  win.visualViewport?.addEventListener("resize", onResize);
  win.visualViewport?.addEventListener("scroll", onResize);
  // The composer mounts / unmounts on route changes and moves with the keyboard without resizing.
  const timer = win.setInterval(update, POLL_MS);
  update();

  return {
    current: () => inset,
    update,
    stop() {
      win.clearInterval(timer);
      win.removeEventListener("resize", onResize);
      win.visualViewport?.removeEventListener("resize", onResize);
      win.visualViewport?.removeEventListener("scroll", onResize);
      resize?.disconnect();
      probe.remove();
      doc.documentElement.style.removeProperty(COMPOSER_INSET_VAR);
    },
  };
}
