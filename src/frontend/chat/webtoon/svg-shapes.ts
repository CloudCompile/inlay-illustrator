// Balloon outlines for a laid-out speech/thought item (port of svg_speech / svg_thought in
// webtoon-bench/scripts/layout.py). Pure data: the renderer builds SVG elements or markup from it.
import type { BalloonItem, Point } from "../../../shared/contract/webtoon.js";

export interface SvgShape {
  tag: "ellipse" | "polygon" | "circle";
  attrs: Record<string, string | number>;
}
/** Paint `outline` first, then `fill`: the fill copies hide the tail stroke where it joins the body. */
export interface BalloonShapes {
  outline: SvgShape[];
  fill: SvgShape[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const pts = (ps: Point[]) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function ellipsePt(cx: number, cy: number, rx: number, ry: number, ang: number): Point {
  return [cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)];
}

export function speechShapes(cx: number, cy: number, rx: number, ry: number, tail: Point | null, shout: boolean): BalloonShapes {
  let body: SvgShape;
  if (shout) {
    // 44-point burst: alternating outer/inner radius
    const n = 22;
    const burst: Point[] = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (Math.PI * i) / n;
      const k = i % 2 === 0 ? 1.18 : 0.98;
      burst.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
    }
    body = { tag: "polygon", attrs: { points: pts(burst) } };
  } else {
    body = { tag: "ellipse", attrs: { cx: r1(cx), cy: r1(cy), rx: r1(rx), ry: r1(ry) } };
  }
  const outline: SvgShape[] = [];
  const fill: SvgShape[] = [];
  if (tail) {
    const [tx, ty] = tail;
    const ang = Math.atan2((ty - cy) / ry, (tx - cx) / rx);
    const b1 = ellipsePt(cx, cy, rx * 0.92, ry * 0.92, ang - 0.2);
    const b2 = ellipsePt(cx, cy, rx * 0.92, ry * 0.92, ang + 0.2);
    const points = pts([b1, tail, b2]);
    outline.push({ tag: "polygon", attrs: { points, fill: "#fff", stroke: "#111", "stroke-width": 5, "stroke-linejoin": "round" } });
    fill.push({ tag: "polygon", attrs: { points, fill: "#fff" } });
  }
  outline.push({ tag: body.tag, attrs: { ...body.attrs, fill: "#fff", stroke: "#111", "stroke-width": 5 } });
  fill.push({ tag: body.tag, attrs: { ...body.attrs, fill: "#fff" } });
  return { outline, fill };
}

export function thoughtShapes(cx: number, cy: number, rx: number, ry: number, tail: Point | null): BalloonShapes {
  const outline: SvgShape[] = [
    {
      tag: "ellipse",
      attrs: { cx: r1(cx), cy: r1(cy), rx: r1(rx), ry: r1(ry), fill: "#fff", stroke: "#555", "stroke-width": 2.5, "stroke-dasharray": "7 5" },
    },
  ];
  if (tail) {
    const [tx, ty] = tail;
    const ang = Math.atan2((ty - cy) / ry, (tx - cx) / rx);
    const [bx, by] = ellipsePt(cx, cy, rx, ry, ang);
    for (const [f, r] of [[0.35, 7], [0.75, 4.5]] as const) {
      outline.push({ tag: "circle", attrs: { cx: r1(bx + (tx - bx) * f), cy: r1(by + (ty - by) * f), r, fill: "#fff", stroke: "#555", "stroke-width": 2 } });
    }
  }
  return { outline, fill: [] };
}

export function balloonShapes(item: BalloonItem): BalloonShapes {
  return item.kind === "thought"
    ? thoughtShapes(item.cx, item.cy, item.rx, item.ry, item.tail)
    : speechShapes(item.cx, item.cy, item.rx, item.ry, item.tail, item.shout);
}

/** SVG markup for one shape (attribute values are numbers or fixed strings, nothing to escape). */
export function shapeToSvg(shape: SvgShape): string {
  const attrs = Object.entries(shape.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${shape.tag}${attrs}/>`;
}
