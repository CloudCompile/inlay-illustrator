import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { PuppetPart } from "../../shared/contract/puppet.js";
import { createPuppetRenderer } from "./renderer.js";

const win = new Window({ url: "http://localhost/" });
const doc = win.document as unknown as Document;
afterAll(() => win.happyDOM.abort());

const RIG: { parts: PuppetPart[] } = {
  parts: [
    { label: "torso", character: 0, box: [0.25, 0.4, 0.75, 1], outline: [], pivot: [0.5, 0.95], parent: -1 },
    { label: "head", character: 0, box: [0.3, 0.05, 0.7, 0.42], outline: [], pivot: [0.5, 0.42], parent: 0 },
  ],
};

/** WebGL stand-in: every call succeeds; texture uploads / deletes and draws are counted. */
function fakeGl() {
  const counts = { uploads: 0, deletes: 0, draws: 0 };
  let id = 0;
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, key: string) {
      if (key === "texImage2D") return () => void counts.uploads++;
      if (key === "deleteTexture") return () => void counts.deletes++;
      if (key === "drawArrays") return () => void counts.draws++;
      if (key === "getShaderParameter") return () => true;
      if (key === "getExtension") return () => null;
      if (/^create|^getUniformLocation$/u.test(key)) return () => ({ id: ++id });
      if (/^[A-Z_0-9]+$/u.test(key)) return 1;
      return () => undefined;
    },
  });
  return { gl: gl as unknown as WebGLRenderingContext, counts };
}

/** Frame + IntersectionObserver + rAF harness. */
function harness() {
  const frames: Array<(t: number) => void> = [];
  const observed = new Map<Element, (records: Array<{ target: Element; isIntersecting: boolean }>) => void>();
  const view = win as unknown as Record<string, unknown>;
  view.requestAnimationFrame = (cb: (t: number) => void) => frames.push(cb);
  view.cancelAnimationFrame = () => undefined;
  view.IntersectionObserver = class {
    constructor(private readonly callback: (records: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
    observe(target: Element) { observed.set(target, this.callback); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { observed.clear(); }
  };
  let now = 0;
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await Bun.sleep(0);
      now += 40;
      frames.splice(0).forEach((cb) => cb(now));
    }
  };
  const setVisible = (canvas: Element, isIntersecting: boolean) => observed.get(canvas)?.([{ target: canvas, isIntersecting }]);
  const target = (width: () => number = () => 200) => {
    const canvas = doc.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { get: width });
    Object.defineProperty(canvas, "clientHeight", { value: 300 });
    (canvas as unknown as { getContext: () => unknown }).getContext = () => ({ clearRect() {}, drawImage() {} });
    const image = { complete: true, naturalWidth: 400, naturalHeight: 600, decode: async () => undefined } as unknown as HTMLImageElement;
    return { canvas, image };
  };
  return { step, setVisible, target, observed };
}

describe("puppet renderer", () => {
  test("without WebGL: unavailable, reported once, images stay still", () => {
    let reported = 0;
    const renderer = createPuppetRenderer({ doc, createContext: () => null, onUnavailable: () => reported++ });
    const { canvas, image } = { canvas: doc.createElement("canvas"), image: doc.createElement("img") as HTMLImageElement };
    renderer.attach({ canvas, image }, RIG).destroy();
    expect(renderer.available).toBe(false);
    expect(reported).toBe(1);
    expect(canvas.style.visibility).toBe("hidden");
    renderer.destroy();
  });

  test("plays only images on screen, at most maxActive, and frees textures of images that leave", async () => {
    const h = harness();
    const { gl, counts } = fakeGl();
    const renderer = createPuppetRenderer({ doc, createContext: () => gl, maxActive: 2 });
    const targets = [h.target(), h.target(), h.target()];
    const handles = targets.map((t) => renderer.attach(t, RIG));
    await h.step(3);
    expect(renderer.playing).toBe(0); // nothing visible yet
    expect(counts.uploads).toBe(0);
    targets.forEach((t) => h.setVisible(t.canvas, true));
    await h.step(4);
    expect(renderer.playing).toBe(2);
    expect(targets.filter((t) => t.canvas.hasAttribute("data-ii-puppet-playing"))).toHaveLength(2);
    expect(counts.uploads).toBe(8); // image + 3 weight textures, for the two playing images
    h.setVisible(targets[0]!.canvas, false);
    await h.step(2);
    expect(counts.deletes).toBe(4);
    expect(targets[0]!.canvas.style.visibility).toBe("hidden");
    expect(renderer.playing).toBe(2); // the third image takes the free slot
    handles.forEach((handle) => handle.destroy());
    await h.step(2);
    expect(renderer.playing).toBe(0);
    renderer.destroy();
  });

  test("uploads the image at its drawn size, and only the image again when that size changes", async () => {
    const h = harness();
    const { gl, counts } = fakeGl();
    const imageUploads: string[] = [];
    const recording = new Proxy(gl as unknown as Record<string, unknown>, {
      get: (target, key: string) => (key === "texImage2D"
        ? (...args: unknown[]) => {
            counts.uploads++;
            const source = args[5] as { width?: number; height?: number; naturalWidth?: number };
            if (args.length === 6) imageUploads.push(source.naturalWidth ? "original" : `${source.width}x${source.height}`);
          }
        : target[key]),
    }) as unknown as WebGLRenderingContext;
    const proto = (win as unknown as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement.prototype;
    const original = proto.getContext;
    proto.getContext = () => ({ drawImage() {}, clearRect() {} });
    try {
      const renderer = createPuppetRenderer({ doc, createContext: () => recording });
      let cssW = 200;
      const target = h.target(() => cssW);
      renderer.attach(target, RIG);
      h.setVisible(target.canvas, true);
      await h.step(4);
      // 400x600 image in a 200x300 box: uploaded at 200x300, not at full size.
      expect(imageUploads).toEqual(["200x300"]);
      cssW = 100;
      await h.step(3);
      expect(imageUploads).toEqual(["200x300", "100x150"]);
      expect(counts.uploads).toBe(5); // the 3 weight textures were not uploaded again
      renderer.destroy();
    } finally {
      proto.getContext = original;
    }
  });

  test("an image that cannot be uploaded stays still without stopping the others", async () => {
    const h = harness();
    const { gl } = fakeGl();
    let calls = 0;
    const throwing = new Proxy(gl as unknown as Record<string, unknown>, {
      get: (target, key: string) => (key === "texImage2D" ? () => { if (calls++ === 0) throw new Error("SecurityError"); } : target[key]),
    }) as unknown as WebGLRenderingContext;
    const renderer = createPuppetRenderer({ doc, createContext: () => throwing });
    const [bad, good] = [h.target(), h.target()];
    renderer.attach(bad, RIG);
    renderer.attach(good, RIG);
    h.setVisible(bad.canvas, true);
    h.setVisible(good.canvas, true);
    await h.step(4);
    expect(bad.canvas.hasAttribute("data-ii-puppet-playing")).toBe(false);
    expect(good.canvas.hasAttribute("data-ii-puppet-playing")).toBe(true);
    renderer.destroy();
  });
});
