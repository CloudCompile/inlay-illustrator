/**
 * Webtoon strip styles (experimental webtoon mode) + the bundled lettering fonts. The canvas is laid out at the layout
 * width (690 px on desktop, narrower on phones) and scaled to the message width. Text classes follow the webtoon bench renderer.
 */
import { BANGERS_WOFF, COMIC_NEUE_BOLD_WOFF, PATRICK_HAND_WOFF } from "./fonts-data.js";

const face = (family: string, data: string, weight = 400) =>
  `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff;base64,${data}) format("woff")}`;

export const WEBTOON_CSS = [
  face("II Webtoon Comic Neue", COMIC_NEUE_BOLD_WOFF, 700),
  face("II Webtoon Patrick Hand", PATRICK_HAND_WOFF),
  face("II Webtoon Bangers", BANGERS_WOFF),
  String.raw`
.ii-wt-strip { position: relative; width: 100%; max-width: 690px; margin: 14px auto 6px; background: #fff; overflow: hidden; border-radius: 4px; color: #111; }
.ii-wt-canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; background: #fff; }
.ii-wt-panel { position: absolute; overflow: hidden; background: #f3f1ee; }
.ii-wt-panel[data-ii-wt-fade="bottom"] { -webkit-mask-image: linear-gradient(#000 62%, transparent 98%); mask-image: linear-gradient(#000 62%, transparent 98%); }
.ii-wt-panel[data-ii-wt-fade="sides"] { -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 9%, #000 91%, transparent 100%); mask-image: linear-gradient(90deg, transparent 0%, #000 9%, #000 91%, transparent 100%); }
.ii-wt-img { display: block; max-width: none; user-select: none; }
.ii-wt-cutout { position: absolute; overflow: hidden; pointer-events: none; }
.ii-wt-placeholder { display: grid; place-items: center; width: 100%; height: 100%; padding: 12px; box-sizing: border-box; font: 600 15px/1.3 system-ui, sans-serif; color: #8a8178; text-align: center; background: repeating-linear-gradient(135deg, #f5f2ee 0 14px, #ece8e2 14px 28px); }
.ii-wt-placeholder[data-ii-wt-state="error"] { color: #b4463c; }
.ii-wt-balloons { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.ii-wt-bt, .ii-wt-narr, .ii-wt-sfx { position: absolute; cursor: text; }
.ii-wt-bt { display: flex; align-items: center; justify-content: center; text-align: center; font-family: "II Webtoon Comic Neue", "Comic Neue", "Comic Sans MS", sans-serif; font-weight: 700; font-size: 19px; line-height: 22px; color: #111; }
.ii-wt-bt.ii-wt-th { font-style: italic; color: #333; }
.ii-wt-narr { box-sizing: border-box; display: flex; align-items: center; justify-content: center; text-align: center; font-family: "II Webtoon Patrick Hand", "Patrick Hand", sans-serif; font-size: 20px; line-height: 24px; color: #111; background: #fff; border: 2px solid #111; padding: 6px 10px; }
.ii-wt-sfx { font-family: "II Webtoon Bangers", Bangers, Impact, sans-serif; line-height: 1; letter-spacing: 2px; text-align: center; text-transform: uppercase; -webkit-text-stroke: 8px #fff; paint-order: stroke fill; text-shadow: 4px 5px 0 #2a1a2a; white-space: nowrap; }
.ii-wt-bt:hover, .ii-wt-narr:hover, .ii-wt-sfx:hover { outline: 2px dashed rgba(215, 140, 60, .7); outline-offset: 2px; }
.ii-wt-title { position: absolute; left: 0; text-align: center; font-family: "II Webtoon Patrick Hand", "Patrick Hand", sans-serif; color: #fff; text-shadow: 0 2px 10px rgba(30, 20, 40, .65); pointer-events: none; }
.ii-wt-title .ii-wt-t1 { font-size: 26px; letter-spacing: 6px; }
.ii-wt-title .ii-wt-t2 { font-size: 62px; line-height: 1.05; margin: 6px 40px 0; }
.ii-wt-title .ii-wt-bar { width: 60px; height: 2px; background: #fff; margin: 20px auto 0; }
.ii-wt-controls { position: absolute; pointer-events: none; }
.ii-wt-tools { position: absolute; display: flex; gap: 6px; }
.ii-wt-reroll, .ii-wt-take { pointer-events: auto; flex: none; width: 36px; height: 36px; border: 0; border-radius: 50%; background: rgba(20, 16, 12, .62); color: #fff; text-align: center; cursor: pointer; opacity: 0; transition: opacity .15s; padding: 0; font: 700 22px/36px system-ui, sans-serif; }
.ii-wt-take { font: 700 28px/32px system-ui, sans-serif; }
.ii-wt-canvas[data-ii-wt-narrow] .ii-wt-reroll, .ii-wt-canvas[data-ii-wt-narrow] .ii-wt-take { width: 48px; height: 48px; font: 700 28px/48px system-ui, sans-serif; }
.ii-wt-canvas[data-ii-wt-narrow] .ii-wt-take { font: 700 34px/44px system-ui, sans-serif; }
.ii-wt-controls[data-ii-wt-hover] button, .ii-wt-controls button:focus-visible, .ii-wt-reroll[data-ii-wt-busy="true"] { opacity: 1; }
.ii-wt-reroll:disabled, .ii-wt-take:disabled { cursor: default; background: rgba(20, 16, 12, .35); }
.ii-wt-controls[data-ii-wt-hover] .ii-wt-take:disabled { opacity: .45; }
.ii-wt-reroll[data-ii-wt-busy="true"] { animation: ii-wt-spin 1s linear infinite; }
@keyframes ii-wt-spin { to { transform: rotate(360deg); } }
@media (pointer: coarse) { .ii-wt-reroll, .ii-wt-take { opacity: .85; } .ii-wt-take:disabled { opacity: .4; } }
.ii-wt-canvas[data-ii-wt-format^="manga"] { background: #d4cfc8; }
.ii-wt-page { position: absolute; background: #fff; }
.ii-wt-canvas[data-ii-wt-format^="manga"] .ii-wt-panel { background: #ececec; }
.ii-wt-canvas[data-ii-wt-grey] .ii-wt-img { filter: grayscale(1); }
.ii-wt-frames { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.ii-wt-frames polygon { fill: none; stroke: #000; stroke-width: 3; stroke-linejoin: miter; }
.ii-wt-canvas[data-ii-wt-format^="manga"] .ii-wt-sfx { text-shadow: none; -webkit-text-stroke: 9px #fff; }
.ii-wt-chapter { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 4px 12px; background: #fff; border: 3px solid #111; color: #111; text-align: center; pointer-events: none; }
.ii-wt-chapter .ii-wt-c1 { font-family: "II Webtoon Patrick Hand", "Patrick Hand", sans-serif; font-size: .53em; letter-spacing: 3px; line-height: 1.2; }
.ii-wt-chapter .ii-wt-c2 { font-family: "II Webtoon Bangers", Bangers, Impact, sans-serif; line-height: 1.05; letter-spacing: 1px; }
.ii-wt-canvas[data-ii-wt-format="manga-pages"] .ii-wt-reroll, .ii-wt-canvas[data-ii-wt-format="manga-pages"] .ii-wt-take { width: 56px; height: 56px; font: 700 34px/56px system-ui, sans-serif; }
.ii-wt-canvas[data-ii-wt-format="manga-pages"] .ii-wt-take { font: 700 42px/50px system-ui, sans-serif; }
.ii-wt-note { padding: 18px; font: 600 14px/1.4 system-ui, sans-serif; color: #6f665c; text-align: center; }
.ii-wt-strip[data-ii-wt-status="error"] .ii-wt-note { color: #b4463c; }
.ii-wt-editor { position: absolute; left: 8px; right: 8px; z-index: 2; display: grid; gap: 6px; padding: 8px; background: #1d1a17; border-radius: 8px; box-shadow: 0 6px 24px rgba(0, 0, 0, .35); }
.ii-wt-editor textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px; font: 16px/1.35 system-ui, sans-serif; color: #f1e5cf; background: #2a2622; border: 1px solid #4a433c; border-radius: 6px; padding: 6px 8px; }
.ii-wt-editor__buttons { display: flex; justify-content: flex-end; gap: 6px; }
.ii-wt-editor button { font: 600 13px system-ui, sans-serif; padding: 6px 12px; border-radius: 6px; border: 1px solid #4a433c; background: #2a2622; color: #f1e5cf; cursor: pointer; }
.ii-wt-editor button[type="submit"] { background: #d7b86f; color: #1d1a17; border-color: #d7b86f; }
`,
].join("\n");
