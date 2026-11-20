// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyframeCacheEntry } from "../player/store/keyframeSlice";
import type { TimelineElement } from "../player/store/timelineElement";
import {
  evaluateBrowserExportEligibility,
  resolveOriginalPreviewMediaUrl,
} from "./browserExportPreflight";
import { capturePreviewLayoutSnapshot, interpolateElementTransform } from "./layoutSnapshot";
import { isAudibleElement, mixTimelineAudio } from "./audioMixer";
import {
  resolveBrowserExportBitrate,
  resolveBrowserExportDimensions,
  resolveIsolatablePreviewUrl,
  runBrowserExport,
} from "./browserExport";

function makeElement(overrides: Partial<TimelineElement>): TimelineElement {
  return {
    id: "el-1",
    tag: "div",
    start: 0,
    duration: 2,
    track: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browserExportPreflight", () => {
  it("accepts mp4 and webm when VideoEncoder and visible elements exist", () => {
    const result = evaluateBrowserExportEligibility({
      format: "mp4",
      elements: [makeElement({ tag: "video", src: "assets/clip.mp4" })],
      duration: 4,
      webCodecsSupported: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects mov/gif, missing VideoEncoder, and empty compositions", () => {
    const unsupportedFormat = evaluateBrowserExportEligibility({
      format: "mov",
      elements: [makeElement({ tag: "img", src: "assets/a.png" })],
      duration: 2,
      webCodecsSupported: true,
    });
    expect(unsupportedFormat.eligible).toBe(false);
    expect(unsupportedFormat.reasons[0]).toContain("MP4 and WebM");

    const noWebCodecs = evaluateBrowserExportEligibility({
      format: "mp4",
      elements: [makeElement({ tag: "img", src: "assets/a.png" })],
      duration: 2,
      webCodecsSupported: false,
    });
    expect(noWebCodecs.eligible).toBe(false);
    expect(noWebCodecs.reasons[0]).toContain("WebCodecs");

    const empty = evaluateBrowserExportEligibility({
      format: "webm",
      elements: [makeElement({ hidden: true })],
      duration: 2,
      webCodecsSupported: true,
    });
    expect(empty.eligible).toBe(false);
  });

  it("surfaces warnings for sub-compositions and custom canvas layers", () => {
    const result = evaluateBrowserExportEligibility({
      format: "mp4",
      elements: [
        makeElement({ id: "sub", tag: "hf-composition", compositionSrc: "parts/intro.html" }),
        makeElement({ id: "cvs", tag: "canvas" }),
      ],
      duration: 3,
      webCodecsSupported: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});

describe("layoutSnapshot & keyframe interpolation", () => {
  it("interpolates and clamps transform and opacity values from keyframeCache", () => {
    const entry: KeyframeCacheEntry = {
      format: "gsap",
      keyframes: [
        { percentage: 20, properties: { x: 0, y: 10, scale: 1, opacity: 0.2, rotation: 0 } },
        { percentage: 80, properties: { x: 100, y: 50, scale: 2, opacity: 1, rotation: 90 } },
      ],
    };

    const before = interpolateElementTransform(entry, 0);
    expect(before).toMatchObject({ x: 0, y: 10, scaleX: 1, scaleY: 1, opacity: 0.2, rotationDeg: 0 });

    const mid = interpolateElementTransform(entry, 50);
    expect(mid).toMatchObject({ x: 50, y: 30, scaleX: 1.5, scaleY: 1.5, rotationDeg: 45 });
    expect(mid.opacity).toBeCloseTo(0.6, 5);

    const after = interpolateElementTransform(entry, 100);
    expect(after).toMatchObject({ x: 100, y: 50, scaleX: 2, scaleY: 2, opacity: 1, rotationDeg: 90 });
  });

  it("snapshots scaled composition rects and computed styles from preview iframe", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `
      <div data-composition-id="root" style="background-color: rgb(12, 24, 36);">
        <p data-hf-id="title-1" style="color: rgb(255, 255, 255); font-size: 24px;">Hello</p>
      </div>
    `;
    const root = doc.querySelector("[data-composition-id]")!;
    const title = doc.querySelector('[data-hf-id="title-1"]')!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}),
    });
    vi.spyOn(title, "getBoundingClientRect").mockReturnValue({
      left: 48, top: 27, width: 240, height: 60, right: 288, bottom: 87, x: 48, y: 27, toJSON: () => ({}),
    });

    const snapshot = capturePreviewLayoutSnapshot(
      iframe,
      [makeElement({ id: "t1", hfId: "title-1", tag: "p" })],
      1920,
      1080,
    );
    expect(snapshot.backgroundColor).toBe("rgb(12, 24, 36)");
    expect(snapshot.elements.get("t1")).toMatchObject({
      left: 96,
      top: 54,
      width: 480,
      height: 120,
      fontSize: 48,
    });
    iframe.remove();
  });
});

describe("audioMixer", () => {
  it("filters audible tracks and schedules playback/gain on OfflineAudioContext", async () => {
    expect(isAudibleElement(makeElement({ tag: "audio", src: "assets/bgm.mp3" }))).toBe(true);
    expect(isAudibleElement(makeElement({ tag: "audio", src: "assets/bgm.mp3", muted: true }))).toBe(false);
    expect(isAudibleElement(makeElement({ tag: "video", src: "assets/v.mp4", hasAudio: false }))).toBe(false);

    const startCalls: Array<[number, number, number]> = [];
    const rampCalls: Array<[number, number]> = [];
    const fakeBuffer = { duration: 10, numberOfChannels: 2, sampleRate: 48000 } as AudioBuffer;

    class MockOfflineAudioContext {
      destination = {};
      decodeAudioData = vi.fn(async () => fakeBuffer);
      createBufferSource = () => ({
        buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: (when: number, offset: number, dur: number) => startCalls.push([when, offset, dur]),
      });
      createGain = () => ({
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: (val: number, time: number) => rampCalls.push([val, time]),
        },
        connect: vi.fn(),
      });
      startRendering = vi.fn(async () => fakeBuffer);
    }

    vi.stubGlobal("OfflineAudioContext", MockOfflineAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );

    const mixed = await mixTimelineAudio({
      projectId: "proj-1",
      duration: 5,
      elements: [
        makeElement({
          id: "a1",
          tag: "audio",
          src: "assets/bgm.mp3",
          start: 1,
          duration: 3,
          playbackStart: 2,
          playbackRate: 1,
          volume: 0.5,
          fadeIn: 0.5,
          fadeOut: 0.5,
        }),
        makeElement({
          id: "a2",
          tag: "audio",
          src: "assets/muted.mp3",
          muted: true,
        }),
      ],
    });

    expect(mixed?.trackCount).toBe(1);
    expect(startCalls).toEqual([[1, 2, 3]]);
    expect(rampCalls).toEqual([
      [0.5, 1.5],
      [0, 4],
    ]);
  });
});

describe("browserExport orchestration", () => {
  it("resolves even dimensions and scales bitrate by quality", () => {
    expect(resolveBrowserExportDimensions("auto", { width: 1081, height: 1921 })).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(resolveBrowserExportBitrate("high", 1920, 1080, 30)).toBeGreaterThan(
      resolveBrowserExportBitrate("draft", 1920, 1080, 30),
    );
  });

  it("renders frames with mediabunny CanvasSource and returns a downloadable blob URL", async () => {
    const addedFrames: Array<[number, number | undefined]> = [];
    const finalized = vi.fn(async () => {});
    const canceled = vi.fn(async () => {});

    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [],
      Mp4OutputFormat: class {
        getSupportedVideoCodecs = () => ["avc"];
        getSupportedAudioCodecs = () => ["aac"];
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs = () => ["vp9"];
        getSupportedAudioCodecs = () => ["opus"];
      },
      BufferTarget: class {
        buffer = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
      },
      Output: class {
        state = "started";
        addVideoTrack = vi.fn();
        addAudioTrack = vi.fn();
        start = vi.fn(async () => {});
        getMimeType = vi.fn(async () => "video/mp4");
        finalize = finalized;
        cancel = canceled;
      },
      CanvasSource: class {
        add = vi.fn(async (t: number, dt?: number) => {
          addedFrames.push([t, dt]);
        });
        close = vi.fn();
      },
      AudioBufferSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      Input: class {
        getPrimaryVideoTrack = vi.fn(async () => null);
        dispose = vi.fn();
      },
      UrlSource: class {},
      CanvasSink: class {},
      getFirstEncodableVideoCodec: vi.fn(async () => "avc"),
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
    }));

    const mockCtx = {
      fillStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "top",
      globalAlpha: 1,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = () => mockCtx;
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-mp4");

    const { runBrowserExport: runMockedExport } = await import("./browserExport");
    const progressUpdates: Array<{ progress: number; stage: string }> = [];
    const result = await runMockedExport({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1280, height: 720 },
      duration: 0.5,
      elements: [
        makeElement({
          id: "txt-1",
          tag: "p",
          text: { value: "Hello Cloud", color: "#ffffff" },
          start: 0,
          duration: 0.5,
        }),
      ],
      keyframeCache: new Map(),
      onProgress: (u) => progressUpdates.push(u),
    });

    expect(addedFrames).toHaveLength(5);
    expect(finalized).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      blobUrl: "blob:mock-mp4",
      mimeType: "video/mp4",
      frameCount: 5,
      width: 1280,
      height: 720,
      stats: {
        htmlMode: "canvas2d",
        snapdomCaptures: 0,
      },
    });
    expect(progressUpdates.at(-1)).toEqual({ progress: 100, stage: "Completed" });
  });

  it("caches static HTML layers in snapdom-cached mode and captures per-frame in snapdom-live mode", async () => {
    const snapdomCalls = vi.fn(async () => ({
      toCanvas: async () => ({ width: 320, height: 120 }),
    }));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: snapdomCalls }));
    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [],
      Mp4OutputFormat: class {
        getSupportedVideoCodecs = () => ["avc"];
        getSupportedAudioCodecs = () => ["aac"];
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs = () => ["vp9"];
        getSupportedAudioCodecs = () => ["opus"];
      },
      BufferTarget: class {
        buffer = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
      },
      Output: class {
        state = "started";
        addVideoTrack = vi.fn();
        addAudioTrack = vi.fn();
        start = vi.fn(async () => {});
        getMimeType = vi.fn(async () => "video/mp4");
        finalize = vi.fn(async () => {});
        cancel = vi.fn(async () => {});
      },
      CanvasSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      AudioBufferSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      Input: class {
        getPrimaryVideoTrack = vi.fn(async () => null);
        dispose = vi.fn();
      },
      UrlSource: class {},
      CanvasSink: class {},
      getFirstEncodableVideoCodec: vi.fn(async () => "avc"),
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
    }));

    const mockCtx = {
      fillStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "top",
      globalAlpha: 1,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = () => mockCtx;
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-snapdom-mp4");

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `<div data-composition-id="root"><div data-hf-id="card-1">Card</div></div>`;

    const { runBrowserExport: runWithSnapdom } = await import("./browserExport");
    const cachedResult = await runWithSnapdom({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1280, height: 720 },
      duration: 0.4,
      elements: [makeElement({ id: "c1", hfId: "card-1", tag: "div", start: 0, duration: 0.4 })],
      keyframeCache: new Map(),
      iframe,
      htmlCaptureMode: "snapdom-cached",
    });
    expect(cachedResult.frameCount).toBe(4);
    expect(cachedResult.stats?.htmlMode).toBe("snapdom-cached");
    expect(cachedResult.stats?.snapdomCaptures).toBe(1);
    expect(snapdomCalls).toHaveBeenCalledTimes(1);

    snapdomCalls.mockClear();
    const liveResult = await runWithSnapdom({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1280, height: 720 },
      duration: 0.4,
      elements: [makeElement({ id: "c1", hfId: "card-1", tag: "div", start: 0, duration: 0.4 })],
      keyframeCache: new Map(),
      iframe,
      htmlCaptureMode: "snapdom-live",
    });
    expect(liveResult.stats?.htmlMode).toBe("snapdom-live");
    expect(liveResult.stats?.snapdomCaptures).toBe(4);
    expect(snapdomCalls).toHaveBeenCalledTimes(4);
    iframe.remove();
  });

  it("isolates live seek into a hidden background iframe without disturbing the visible preview iframe", async () => {
    const snapdomCalls = vi.fn(async () => ({
      toCanvas: async () => ({ width: 320, height: 120 }),
    }));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: snapdomCalls }));
    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [],
      Mp4OutputFormat: class {
        getSupportedVideoCodecs = () => ["avc"];
        getSupportedAudioCodecs = () => ["aac"];
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs = () => ["vp9"];
        getSupportedAudioCodecs = () => ["opus"];
      },
      BufferTarget: class {
        buffer = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
      },
      Output: class {
        state = "started";
        addVideoTrack = vi.fn();
        addAudioTrack = vi.fn();
        start = vi.fn(async () => {});
        getMimeType = vi.fn(async () => "video/mp4");
        finalize = vi.fn(async () => {});
        cancel = vi.fn(async () => {});
      },
      CanvasSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      AudioBufferSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      Input: class {
        getPrimaryVideoTrack = vi.fn(async () => null);
        dispose = vi.fn();
      },
      UrlSource: class {},
      CanvasSink: class {},
      getFirstEncodableVideoCodec: vi.fn(async () => "avc"),
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
    }));

    const mockCtx = {
      fillStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "top",
      globalAlpha: 1,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = () => mockCtx;
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-isolated-mp4");

    const visibleSeek = vi.fn();
    const visibleIframe = document.createElement("iframe");
    visibleIframe.setAttribute("src", "http://127.0.0.1:4123/api/projects/proj-1/preview");
    Object.defineProperty(visibleIframe, "src", {
      get: () => "http://127.0.0.1:4123/api/projects/proj-1/preview",
    });
    const visibleDoc = document.implementation.createHTMLDocument("visible");
    visibleDoc.body.innerHTML = `<div data-composition-id="root"><div data-hf-id="card-1">Card</div></div>`;
    Object.defineProperty(visibleIframe, "contentDocument", { get: () => visibleDoc });
    Object.defineProperty(visibleIframe, "contentWindow", {
      get: () => ({ __playerReady: true, __player: { seek: visibleSeek } }),
    });

    const isolatedSeek = vi.fn();
    const isolatedPause = vi.fn();
    const isolatedDoc = document.implementation.createHTMLDocument("isolated");
    isolatedDoc.body.innerHTML = `<div data-composition-id="root"><div data-hf-id="card-1">Card</div></div>`;
    Object.defineProperty(isolatedDoc, "URL", {
      get: () => "http://127.0.0.1:4123/api/projects/proj-1/preview",
    });
    Object.defineProperty(isolatedDoc, "readyState", {
      get: () => "complete",
      configurable: true,
    });

    const origCreateElement = document.createElement.bind(document);
    let createdExportFrame: HTMLIFrameElement | null = null;
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreateElement(tagName, options);
      if (tagName.toLowerCase() === "iframe") {
        createdExportFrame = el as HTMLIFrameElement;
        Object.defineProperty(el, "src", {
          get: () => el.getAttribute("src") ?? "",
          set: (val: string) => {
            el.setAttribute("src", val);
            queueMicrotask(() => el.dispatchEvent(new Event("load")));
          },
          configurable: true,
        });
        Object.defineProperty(el, "contentDocument", {
          get: () => isolatedDoc,
          configurable: true,
        });
        Object.defineProperty(el, "contentWindow", {
          get: () => ({
            __playerReady: true,
            __player: { seek: isolatedSeek, pause: isolatedPause },
          }),
          configurable: true,
        });
      }
      return el;
    }) as typeof document.createElement);

    const { runBrowserExport: runIsolated } = await import("./browserExport");
    const result = await runIsolated({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1280, height: 720 },
      duration: 0.3,
      elements: [makeElement({ id: "c1", hfId: "card-1", tag: "div", start: 0, duration: 0.3 })],
      keyframeCache: new Map(),
      iframe: visibleIframe,
      htmlCaptureMode: "snapdom-live",
    });

    expect(result.frameCount).toBe(3);
    expect(createdExportFrame).not.toBeNull();
    expect(isolatedPause).toHaveBeenCalledTimes(1);
    expect(isolatedSeek).toHaveBeenCalled();
    expect(visibleSeek).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openmotion-export-frame="true"]')).toBeNull();
  });

  it("re-measures delayed sub-compositions (start > 0) at seek time instead of keeping t=0 opacity 0", async () => {
    const snapdomCalls = vi.fn(async () => ({
      toCanvas: async () => ({ width: 1920, height: 1080 }),
    }));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: snapdomCalls }));
    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [],
      Mp4OutputFormat: class {
        getSupportedVideoCodecs = () => ["avc"];
        getSupportedAudioCodecs = () => ["aac"];
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs = () => ["vp9"];
        getSupportedAudioCodecs = () => ["opus"];
      },
      BufferTarget: class {
        buffer = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
      },
      Output: class {
        state = "started";
        addVideoTrack = vi.fn();
        addAudioTrack = vi.fn();
        start = vi.fn(async () => {});
        getMimeType = vi.fn(async () => "video/mp4");
        finalize = vi.fn(async () => {});
        cancel = vi.fn(async () => {});
      },
      CanvasSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      AudioBufferSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      Input: class {
        getPrimaryVideoTrack = vi.fn(async () => null);
        dispose = vi.fn();
      },
      UrlSource: class {},
      CanvasSink: class {},
      getFirstEncodableVideoCodec: vi.fn(async () => "avc"),
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
    }));

    const mockCtx = {
      fillStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "top",
      globalAlpha: 1,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = () => mockCtx;
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-delayed-mp4");

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `
      <div data-composition-id="root">
        <div data-hf-id="delayed-sub" style="opacity: 0;">Scene 2</div>
      </div>
    `;
    const root = doc.querySelector("[data-composition-id]")!;
    const sub = doc.querySelector('[data-hf-id="delayed-sub"]') as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080, x: 0, y: 0, toJSON: () => ({}),
    });
    vi.spyOn(sub, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080, x: 0, y: 0, toJSON: () => ({}),
    });
    Object.defineProperty(iframe, "contentWindow", {
      get: () => ({
        __playerReady: true,
        __player: {
          seek: (t: number) => {
            sub.style.opacity = t >= 0.2 ? "1" : "0";
          },
        },
      }),
    });

    const { runBrowserExport: runDelayed } = await import("./browserExport");
    const result = await runDelayed({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1920, height: 1080 },
      duration: 0.4,
      elements: [
        makeElement({
          id: "sub-2",
          hfId: "delayed-sub",
          tag: "div",
          compositionSrc: "compositions/scene2.html",
          start: 0.2,
          duration: 0.2,
        }),
      ],
      keyframeCache: new Map(),
      iframe,
      isolateIframe: false,
      htmlCaptureMode: "snapdom-live",
    });

    expect(result.frameCount).toBe(4);
    expect(result.stats?.snapdomCaptures).toBe(2);
    expect(snapdomCalls).toHaveBeenCalledTimes(2);
    iframe.remove();
  });
});

describe("cloud preview adaptation", () => {
  it("appends original=1 on project preview media URLs while leaving other sources untouched", () => {
    expect(
      resolveOriginalPreviewMediaUrl(
        "/api/projects/proj-1/preview/assets/clip.mp4",
        "proj-1",
        "https://studio.example.com",
      ),
    ).toBe("/api/projects/proj-1/preview/assets/clip.mp4?original=1");

    expect(
      resolveOriginalPreviewMediaUrl(
        "https://studio.example.com/api/projects/proj-1/preview/assets/clip.mp4?v=2",
        "proj-1",
        "https://studio.example.com",
      ),
    ).toBe("https://studio.example.com/api/projects/proj-1/preview/assets/clip.mp4?v=2&original=1");

    expect(
      resolveOriginalPreviewMediaUrl(
        "/api/projects/proj-1/preview/assets/clip.mp4?raw=1",
        "proj-1",
        "https://studio.example.com",
      ),
    ).toBe("/api/projects/proj-1/preview/assets/clip.mp4?raw=1");

    expect(
      resolveOriginalPreviewMediaUrl(
        "https://cdn.example.com/clip.mp4",
        "proj-1",
        "https://studio.example.com",
      ),
    ).toBe("https://cdn.example.com/clip.mp4");

    expect(resolveOriginalPreviewMediaUrl("data:image/png;base64,abc", "proj-1")).toBe(
      "data:image/png;base64,abc",
    );
    expect(resolveOriginalPreviewMediaUrl("blob:https://studio.example.com/123", "proj-1")).toBe(
      "blob:https://studio.example.com/123",
    );
  });

  it("falls back to same-origin preview route when the visible preview iframe is cross-origin", () => {
    const sameOriginIframe = document.createElement("iframe");
    sameOriginIframe.setAttribute("src", "https://studio.example.com/api/projects/proj-1/preview");
    expect(
      resolveIsolatablePreviewUrl(sameOriginIframe, "proj-1", "https://studio.example.com"),
    ).toBe("https://studio.example.com/api/projects/proj-1/preview");

    const crossOriginNullDoc = document.createElement("iframe");
    crossOriginNullDoc.setAttribute("src", "https://preview.example.com/api/projects/proj-1/preview");
    Object.defineProperty(crossOriginNullDoc, "contentDocument", {
      get: () => null,
    });
    expect(
      resolveIsolatablePreviewUrl(crossOriginNullDoc, "proj-1", "https://studio.example.com"),
    ).toBe("/api/projects/proj-1/preview?original=1");

    const crossOriginThrowing = document.createElement("iframe");
    crossOriginThrowing.setAttribute("src", "https://preview.example.com/api/projects/proj-1/preview");
    Object.defineProperty(crossOriginThrowing, "contentDocument", {
      get: () => {
        throw new Error("Blocked a frame with origin");
      },
    });
    expect(
      resolveIsolatablePreviewUrl(crossOriginThrowing, "proj-1", "https://studio.example.com"),
    ).toBe("/api/projects/proj-1/preview?original=1");
  });

  it("auto-selects snapdom-live for delayed HTML elements (start > 0) even without explicit mode", async () => {
    const snapdomCalls = vi.fn(async () => ({
      toCanvas: async () => ({ width: 400, height: 120 }),
    }));
    vi.doMock("@zumer/snapdom", () => ({ snapdom: snapdomCalls }));
    vi.doMock("mediabunny", () => ({
      ALL_FORMATS: [],
      Mp4OutputFormat: class {
        getSupportedVideoCodecs = () => ["avc"];
        getSupportedAudioCodecs = () => ["aac"];
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs = () => ["vp9"];
        getSupportedAudioCodecs = () => ["opus"];
      },
      BufferTarget: class {
        buffer = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]).buffer;
      },
      Output: class {
        state = "started";
        addVideoTrack = vi.fn();
        addAudioTrack = vi.fn();
        start = vi.fn(async () => {});
        getMimeType = vi.fn(async () => "video/mp4");
        finalize = vi.fn(async () => {});
        cancel = vi.fn(async () => {});
      },
      CanvasSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      AudioBufferSource: class {
        add = vi.fn(async () => {});
        close = vi.fn();
      },
      Input: class {
        getPrimaryVideoTrack = vi.fn(async () => null);
        dispose = vi.fn();
      },
      UrlSource: class {},
      CanvasSink: class {},
      getFirstEncodableVideoCodec: vi.fn(async () => "avc"),
      getFirstEncodableAudioCodec: vi.fn(async () => "aac"),
    }));
    const mockCtx = {
      fillStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "top",
      globalAlpha: 1,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext = () => mockCtx;
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-auto-live");

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = `<div data-composition-id="root"><div data-hf-id="delayed-pill">Delayed</div></div>`;

    const { runBrowserExport: runAuto } = await import("./browserExport");
    const result = await runAuto({
      projectId: "proj-1",
      format: "mp4",
      quality: "standard",
      fps: 10,
      compositionDimensions: { width: 1280, height: 720 },
      duration: 0.4,
      elements: [makeElement({ id: "d1", hfId: "delayed-pill", tag: "div", start: 0.2, duration: 0.2 })],
      keyframeCache: new Map(),
      iframe,
      isolateIframe: false,
    });
    expect(result.stats?.htmlMode).toBe("snapdom-live");
    iframe.remove();
  });
});
