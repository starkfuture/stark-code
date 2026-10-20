// @effect-diagnostics nodeBuiltinImport:off - Execute the bundled panel in a constrained test VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { prepareStarkWorkbench } from "./prepare-stark-workbench.mjs";

it("switches only a trusted host to document layout and preserves guarded publish controls", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-page-layout-"));
  try {
    const kit = prepareStarkWorkbench({ destination: NodePath.join(scratch, "kit") });
    const url = NodeURL.pathToFileURL(NodePath.join(kit, "packages/spage/src/panel.js")).href;
    const options = {
      nonce: "layout-test",
      csrf: null,
      embedOrigins: ["starkcode:"],
      port: 4317,
      root: "/project",
      initial: { slug: "test-page", title: "Test page", rev: 1 },
    };
    const html = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {renderPanel}=await import(${JSON.stringify(url)}); process.stdout.write(renderPanel(${JSON.stringify(options)}));`,
      ],
      { encoding: "utf8" },
    );
    const script = html.match(/<script nonce="layout-test">([\s\S]*?)<\/script>/)![1]!;
    const config = html.match(
      /<script type="application\/json" id="config">([\s\S]*?)<\/script>/,
    )![1]!;
    const listeners = new Map<string, (event: unknown) => void>();
    const nodes = new Map<
      string,
      {
        src: string;
        textContent: string;
        hidden: boolean;
        addEventListener: ReturnType<typeof vi.fn>;
        setAttribute: ReturnType<typeof vi.fn>;
      }
    >();
    const element = (id: string) => {
      if (!nodes.has(id))
        nodes.set(id, {
          src: "",
          textContent: id === "config" ? config : "",
          hidden: false,
          addEventListener: vi.fn(),
          setAttribute: vi.fn(),
        });
      return nodes.get(id)!;
    };
    const events = new Map<string, (event: { data: string }) => void>();
    class EventSource {
      addEventListener(name: string, listener: (event: { data: string }) => void) {
        events.set(name, listener);
      }
    }
    const parent = { postMessage: vi.fn() };
    const body = { setAttribute: vi.fn() };
    NodeVM.runInNewContext(script, {
      window: {
        parent,
        location: { ancestorOrigins: ["starkcode://app"] },
        addEventListener: (name: string, listener: (event: unknown) => void) =>
          listeners.set(name, listener),
      },
      document: { body, getElementById: element, addEventListener: vi.fn() },
      URL,
      EventSource,
    });
    expect(element("view").src).toContain("view=panel");
    const host = {
      v: 1,
      source: "stark-host",
      type: "host",
      agent: "codex",
      canPublish: false,
      presentation: "document",
    };
    const dispatch = (origin: string, source: unknown, data = host) =>
      listeners.get("message")!({ origin, source, data });
    dispatch("https://untrusted.example", parent);
    dispatch("starkcode://app", {});
    expect(element("view").src).toContain("view=panel");
    dispatch("starkcode://app", parent);
    expect(body.setAttribute).toHaveBeenCalledWith("data-presentation", "document");
    expect(element("view").src).toBe("/p/test-page/?rev=1");
    expect(element("pick").textContent).toBe("Page library");
    expect(element("open").textContent).toBe("Open in browser");
    expect(element("folder-context").textContent).toBe("Folder pages · project");
    expect(element("publish").hidden).toBe(true);
    // Repeated host capability updates do not reload the document being read.
    element("view").src = "retained-reading-position";
    dispatch("starkcode://app", parent);
    expect(element("view").src).toBe("retained-reading-position");
    events.get("show")!({
      data: JSON.stringify({ slug: "another-page", title: "Other page", rev: 2 }),
    });
    expect(element("view").src).toBe("retained-reading-position");
    expect(element("next").hidden).toBe(true);
    events.get("show")!({
      data: JSON.stringify({ slug: "test-page", title: "Test page", rev: 3 }),
    });
    expect(element("next").hidden).toBe(false);
    expect(element("next").textContent).toBe("Update available");
    expect(element("view").src).toBe("retained-reading-position");
    const nextClick = element("next").addEventListener.mock.calls.find(
      ([event]) => event === "click",
    )![1];
    nextClick();
    expect(element("view").src).toBe("/p/test-page/?rev=3");
    dispatch("starkcode://app", parent, { ...host, presentation: "panel" });
    expect(element("view").src).toContain("view=panel");
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
