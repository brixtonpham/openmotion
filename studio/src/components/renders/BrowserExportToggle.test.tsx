// @vitest-environment happy-dom

import { StudioHostContext } from "../../motion/StudioHost";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderQueue, type StartRenderHandler } from "./RenderQueue";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("VideoFrame", class {});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("BrowserExportToggle integration in RenderQueue", () => {
  it("unblocks export when ffmpeg is missing and routes startRender with engine='browser'", () => {
    const onStartRender = vi.fn<StartRenderHandler>();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <StudioHostContext.Provider value={{ mvpEditor: false }}>
          <RenderQueue
            jobs={[]}
            projectId="demo"
            onDelete={vi.fn()}
            onClearCompleted={vi.fn()}
            onStartRender={onStartRender}
            isRendering={false}
            compositionDimensions={{ width: 1920, height: 1080 }}
            ffmpeg={{ ok: false, mode: "remote-worker", title: "Render worker unavailable" }}
            ffmpegChecking={false}
            onRecheckFfmpeg={vi.fn()}
          />
        </StudioHostContext.Provider>,
      );
    });

    const exportBtn = host.querySelector<HTMLButtonElement>('[data-testid="renders-export"]')!;
    expect(exportBtn.disabled).toBe(true);

    const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Browser export (Beta)"]')!;
    expect(toggle).toBeTruthy();
    act(() => toggle.click());

    expect(exportBtn.disabled).toBe(false);
    act(() => exportBtn.click());

    expect(onStartRender).toHaveBeenCalledExactlyOnceWith(
      "mp4",
      "standard",
      "auto",
      30,
      false,
      undefined,
      "browser",
    );
  });
});
