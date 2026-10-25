/**
 * Shared puppet renderer: ONE WebGL context draws every animated chat image (browsers cap live contexts at ~16, a long
 * chat has more images). Each animated image gets a plain 2D canvas over it; per frame the renderer warps the image in
 * the shared context and copies the result into that canvas.
 * - Only images on screen play (IntersectionObserver), at most `maxActive` at once, at `fps` (default 30); GPU textures of
 *   images that leave the screen are released and uploaded again when they come back (the CPU weights stay cached).
 * - Nothing plays while the tab is hidden or the system asks for reduced motion.
 * - Fallbacks keep the original <img> visible: no WebGL (`available` false, `onUnavailable` once), an image that cannot
 *   be decoded or uploaded, a lost context (resumes after `webglcontextrestored`).
 * Motion model: ./motion.ts.
 */
import { PUPPET_MAX_PARTS, type PuppetRig } from "../../shared/contract/puppet.js";
import { buildWeights, createMotion, LOOP_SECONDS, packWeights, prepareParts, type PuppetFrame, type WeightMaps } from "./motion.js";

export interface PuppetTarget { canvas: HTMLCanvasElement; image: HTMLImageElement }
export interface PuppetHandle { destroy(): void }

export interface PuppetRenderer {
  /** False when WebGL is unavailable: attached images stay still. */
  readonly available: boolean;
  /** Paused by the system's reduced-motion preference. */
  readonly reducedMotion: boolean;
  attach(target: PuppetTarget, rig: Pick<PuppetRig, "parts">): PuppetHandle;
  /** Number of images drawn on the last frame (tests / diagnostics). */
  readonly playing: number;
  destroy(): void;
}

export interface PuppetRendererOptions {
  doc?: Document;
  maxActive?: number;
  fps?: number;
  /** Strength multiplier of every motion (1 = the tested default). */
  strength?: number;
  /** Context factory (tests). */
  createContext?: (canvas: HTMLCanvasElement) => WebGLRenderingContext | null;
  /** Called once when WebGL is missing. */
  onUnavailable?: () => void;
}

const VS = "attribute vec2 a;varying vec2 v;void main(){v=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}";
const WEIGHT_TEXTURES = PUPPET_MAX_PARTS / 4;
const FS = `precision highp float;
uniform sampler2D uImg,uW0,uW1,uW2;uniform vec2 uSize;
uniform vec3 uA[${PUPPET_MAX_PARTS}],uB[${PUPPET_MAX_PARTS}],uR[${PUPPET_MAX_PARTS}];varying vec2 v;
void main(){vec2 p=v*uSize;vec4 a=texture2D(uW0,v),b=texture2D(uW1,v),c=texture2D(uW2,v);
float w[${PUPPET_MAX_PARTS}];w[0]=a.r;w[1]=a.g;w[2]=a.b;w[3]=a.a;w[4]=b.r;w[5]=b.g;w[6]=b.b;w[7]=b.a;w[8]=c.r;w[9]=c.g;w[10]=c.b;w[11]=c.a;
vec2 d=vec2(0.);vec3 h=vec3(p,1.);
for(int i=0;i<${PUPPET_MAX_PARTS};i++){
d+=w[i]*vec2(dot(uA[i],h),dot(uB[i],h));
d.y+=w[i]*uR[i].z*clamp((uR[i].x-p.y)/max(1.,uR[i].x-uR[i].y),0.,1.);}
gl_FragColor=vec4(texture2D(uImg,(p-d)/uSize).rgb,1.);}`;

interface Prepared {
  width: number;
  height: number;
  weights: WeightMaps;
  packed: Uint8Array[];
  frame: (t: number) => PuppetFrame;
}

interface Entry {
  target: PuppetTarget;
  rig: Pick<PuppetRig, "parts">;
  visible: boolean;
  prepared?: Prepared;
  preparing?: boolean;
  failed?: boolean;
  textures?: WebGLTexture[];
  /** Draw size the image texture was scaled to ("WxH"). */
  imageSize?: string;
  shown: boolean;
}

function show(entry: Entry, on: boolean): void {
  if (entry.shown === on) return;
  entry.shown = on;
  entry.target.canvas.style.visibility = on ? "visible" : "hidden";
  entry.target.canvas.toggleAttribute("data-ii-puppet-playing", on);
}

async function loadedImage(image: HTMLImageElement): Promise<boolean> {
  if (!image.complete) await new Promise<void>((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
  if (typeof image.decode === "function") await image.decode().catch(() => undefined);
  return image.naturalWidth > 0 && image.naturalHeight > 0;
}

export function createPuppetRenderer(options: PuppetRendererOptions = {}): PuppetRenderer {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const maxActive = options.maxActive ?? 4;
  const frameMs = 1000 / (options.fps ?? 30);
  const strength = options.strength ?? 1;
  const entries = new Set<Entry>();
  const glCanvas = doc.createElement("canvas");
  glCanvas.width = glCanvas.height = 1;
  // Images are uploaded at the size they are drawn: WebGL1 has no mipmaps for non-power-of-two textures, so sampling a
  // large image down in the shader aliases (jagged line art that shimmers as parts move).
  const scaler = doc.createElement("canvas");
  const contextOf = options.createContext ?? ((c) => c.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null);
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = contextOf(glCanvas);
  } catch {
    gl = null;
  }
  const available = !!gl;
  if (!available) options.onUnavailable?.();
  let program: WebGLProgram | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let lost = false;
  let destroyed = false;
  let raf = 0;
  let last = 0;
  let playing = 0;
  const motionQuery = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function init(): void {
    if (!gl) return;
    const shader = (type: number, source: string) => {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, source);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const weightNames = Array.from({ length: WEIGHT_TEXTURES }, (_, i) => `uW${i}`);
    uniforms = Object.fromEntries(["uImg", ...weightNames, "uSize", "uA", "uB", "uR"].map((n) => [n, gl!.getUniformLocation(program!, n)]));
    gl.uniform1i(uniforms.uImg!, 0);
    weightNames.forEach((name, i) => gl!.uniform1i(uniforms[name]!, i + 1));
  }

  function texture(unit: number, upload: (gl: WebGLRenderingContext) => void): WebGLTexture {
    const g = gl!;
    const tex = g.createTexture()!;
    g.activeTexture(g.TEXTURE0 + unit);
    g.bindTexture(g.TEXTURE_2D, tex);
    upload(g);
    for (const [k, value] of [[g.TEXTURE_MIN_FILTER, g.LINEAR], [g.TEXTURE_MAG_FILTER, g.LINEAR], [g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE], [g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE]] as const) g.texParameteri(g.TEXTURE_2D, k, value);
    return tex;
  }

  function release(entry: Entry): void {
    if (entry.textures && gl && !lost) for (const tex of entry.textures) gl.deleteTexture(tex);
    entry.textures = undefined;
    entry.imageSize = undefined;
  }

  /** The image, scaled down to `w` x `h` when it is larger (the original when no 2D context is available). */
  function scaledImage(image: HTMLImageElement, w: number, h: number): TexImageSource {
    if (w >= image.naturalWidth && h >= image.naturalHeight) return image;
    scaler.width = w;
    scaler.height = h;
    const ctx = scaler.getContext("2d");
    if (!ctx) return image;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, w, h);
    return scaler;
  }

  async function prepare(entry: Entry): Promise<void> {
    if (entry.prepared || entry.preparing || entry.failed) return;
    entry.preparing = true;
    try {
      if (!(await loadedImage(entry.target.image))) {
        entry.failed = true;
        return;
      }
      const width = entry.target.image.naturalWidth, height = entry.target.image.naturalHeight;
      const parts = prepareParts(entry.rig, width, height);
      const weights = buildWeights(parts, width, height);
      entry.prepared = { width, height, weights, packed: packWeights(weights), frame: createMotion(parts, height, strength) };
    } catch {
      entry.failed = true;
    } finally {
      entry.preparing = false;
      if (entries.has(entry)) wake();
    }
  }

  function draw(entry: Entry, t: number): boolean {
    const g = gl!, prepared = entry.prepared!;
    const canvas = entry.target.canvas;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (cssW < 2 || cssH < 2) return false;
    const scale = Math.min(win.devicePixelRatio || 1, prepared.width / cssW);
    const bw = Math.max(1, Math.round(cssW * scale)), bh = Math.max(1, Math.round(cssH * scale));
    const fit = Math.min(bw / prepared.width, bh / prepared.height);
    const dw = Math.max(1, Math.round(prepared.width * fit)), dh = Math.max(1, Math.round(prepared.height * fit));
    const imageSize = `${dw}x${dh}`;
    try {
      if (!entry.textures) {
        const { width, height } = prepared.weights;
        entry.textures = [
          texture(0, (gl) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scaledImage(entry.target.image, dw, dh))),
          ...prepared.packed.map((data, i) => texture(i + 1, (gl) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data))),
        ];
      } else if (entry.imageSize !== imageSize) {
        // Resized (layout or zoom): only the image texture depends on the draw size.
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, entry.textures[0]!);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, scaledImage(entry.target.image, dw, dh));
      }
      entry.imageSize = imageSize;
    } catch {
      // Cross-origin or undecodable image: it stays still.
      release(entry);
      entry.failed = true;
      return false;
    }
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    if (glCanvas.width < dw) glCanvas.width = dw;
    if (glCanvas.height < dh) glCanvas.height = dh;
    entry.textures.forEach((tex, unit) => {
      g.activeTexture(g.TEXTURE0 + unit);
      g.bindTexture(g.TEXTURE_2D, tex);
    });
    const { mats, ramps } = prepared.frame(t);
    const A = new Float32Array(PUPPET_MAX_PARTS * 3), B = new Float32Array(PUPPET_MAX_PARTS * 3), R = new Float32Array(PUPPET_MAX_PARTS * 3);
    mats.forEach((m, i) => {
      A.set([m[0] - 1, m[1], m[2]], i * 3);
      B.set([m[3], m[4] - 1, m[5]], i * 3);
      R.set(ramps[i]!, i * 3);
    });
    g.uniform2f(uniforms.uSize!, prepared.width, prepared.height);
    g.uniform3fv(uniforms.uA!, A);
    g.uniform3fv(uniforms.uB!, B);
    g.uniform3fv(uniforms.uR!, R);
    g.viewport(0, 0, dw, dh);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.clearRect(0, 0, bw, bh);
    ctx.drawImage(glCanvas, 0, glCanvas.height - dh, dw, dh, Math.round((bw - dw) / 2), Math.round((bh - dh) / 2), dw, dh);
    return true;
  }

  function tick(now: number): void {
    raf = 0;
    if (destroyed || !gl || lost) return;
    const paused = doc.hidden || !!motionQuery?.matches;
    const candidates = paused ? [] : [...entries].filter((e) => e.visible && !e.failed);
    for (const entry of candidates) if (!entry.prepared) void prepare(entry);
    const active = candidates.filter((e) => e.prepared).slice(0, maxActive);
    for (const entry of entries) {
      if (active.includes(entry)) continue;
      show(entry, false);
      if (!entry.visible) release(entry);
    }
    if (!active.length) {
      playing = 0;
      return;
    }
    if (now - last >= frameMs - 2) {
      last = now;
      const t = (now / 1000 / LOOP_SECONDS) % 1;
      playing = 0;
      for (const entry of active) {
        const ok = draw(entry, t);
        show(entry, ok);
        if (ok) playing++;
      }
    }
    raf = win.requestAnimationFrame(tick);
  }

  function wake(): void {
    if (!raf && !destroyed && gl && !lost) raf = win.requestAnimationFrame(tick);
  }

  const observer = typeof win.IntersectionObserver === "function"
    ? new win.IntersectionObserver((records) => {
        for (const record of records) {
          for (const entry of entries) if (entry.target.canvas === record.target) entry.visible = record.isIntersecting;
        }
        wake();
      }, { rootMargin: "120px" })
    : null;

  const onVisibility = () => wake();
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    for (const entry of entries) {
      entry.textures = undefined;
      show(entry, false);
    }
  };
  const onRestored = () => {
    lost = false;
    try {
      init();
      wake();
    } catch {
      lost = true;
    }
  };
  if (gl) {
    try {
      init();
    } catch {
      gl = null;
    }
    glCanvas.addEventListener("webglcontextlost", onLost);
    glCanvas.addEventListener("webglcontextrestored", onRestored);
    doc.addEventListener("visibilitychange", onVisibility);
    motionQuery?.addEventListener?.("change", onVisibility);
  }

  return {
    get available() {
      return available && !!gl;
    },
    get reducedMotion() {
      return !!motionQuery?.matches;
    },
    get playing() {
      return playing;
    },
    attach(target, rig) {
      const entry: Entry = { target, rig, visible: !observer, shown: true };
      show(entry, false);
      if (!gl) return { destroy() {} };
      entries.add(entry);
      observer?.observe(target.canvas);
      wake();
      return {
        destroy() {
          if (!entries.delete(entry)) return;
          observer?.unobserve(target.canvas);
          release(entry);
          show(entry, false);
        },
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) win.cancelAnimationFrame(raf);
      observer?.disconnect();
      for (const entry of entries) {
        release(entry);
        show(entry, false);
      }
      entries.clear();
      doc.removeEventListener("visibilitychange", onVisibility);
      motionQuery?.removeEventListener?.("change", onVisibility);
      glCanvas.removeEventListener("webglcontextlost", onLost);
      glCanvas.removeEventListener("webglcontextrestored", onRestored);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      gl = null;
    },
  };
}
