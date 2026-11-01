import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ChromeCdpAdapter } from "../dist/adapters/index.js";
const fixture = fileURLToPath(
  new URL("../tests/fixtures/lineage/", import.meta.url),
);
export async function startFixture() {
  const script = await build({
    entryPoints: [join(fixture, "scene.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "~/lib/utils": join(fixture, "cn.ts") },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const cssSource = await readFile(join(fixture, "style.css"), "utf8");
  const compiler = await compile(cssSource, {
    base: fixture,
    onDependency: () => {},
  });
  const content = await Promise.all(
    ["scene.tsx", "TaskGroup.tsx", "AnimatedBeam.tsx"].map((f) =>
      readFile(join(fixture, f), "utf8"),
    ),
  );
  const candidates = [
    ...new Set(
      content
        .join(" ")
        .split(/[\s"'`{}(),]+/)
        .filter(Boolean),
    ),
  ];
  const css = compiler.build(candidates);
  const html =
    '<!doctype html><html><head><title>Radix observation fixture</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/scene.js"></script></body></html>';
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    const body =
      path === "/style.css"
        ? css
        : path === "/scene.js"
          ? script.outputFiles[0].text
          : html;
    res.setHeader(
      "Content-Type",
      path === "/style.css"
        ? "text/css"
        : path === "/scene.js"
          ? "text/javascript"
          : "text/html",
    );
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = await mkdtemp(join(tmpdir(), "radix-ui-fixture-"));
  const browser = spawn(
    process.env.UI_OBSERVATION_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--window-size=800,600",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  browser.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-10000);
  });
  let launchError;
  browser.on("error", (e) => {
    launchError = e;
  });
  let adapter;
  const close = async () => {
    await adapter?.close();
    if (browser.exitCode === null && !browser.killed) {
      browser.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => browser.once("exit", r)),
        sleep(3000),
      ]);
      if (browser.exitCode === null) browser.kill("SIGKILL");
    }
    await new Promise((r) => server.close(r));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  try {
    let port;
    for (let i = 0; i < 150; i++) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw Error(stderr);
      try {
        port = Number(
          (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
            "\n",
          )[0],
        );
        break;
      } catch {
        await sleep(100);
      }
    }
    if (!port) throw Error("Chrome debug endpoint unavailable: " + stderr);
    const version = await (
      await fetch(`http://127.0.0.1:${port}/json/version`)
    ).json();
    let target;
    for (let i = 0; i < 50; i++) {
      const all = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      const matches = all.filter((t) => t.url === url);
      if (matches.length === 1) {
        target = matches[0];
        break;
      }
      await sleep(100);
    }
    if (!target) throw Error("Fixture target not unique");
    const selection = {
      endpoint: version.webSocketDebuggerUrl,
      targetId: target.id,
      expectedUrl: url,
      timeoutMs: 5000,
    };
    adapter = new ChromeCdpAdapter();
    await adapter.connect(selection);
    await adapter.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await adapter.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "no-preference" },
      ],
    });
    for (let i = 0; i < 100; i++) {
      if (
        await adapter.evaluate(
          'document.documentElement.dataset.ready==="true" && !!document.querySelector("[data-lineage-beam] path")?.getAttribute("d")',
        )
      )
        break;
      await sleep(50);
    }
    await sleep(200);
    return {
      url,
      selection,
      close,
      profile,
      pid: browser.pid,
      adapter,
      html,
      css,
      script: script.outputFiles[0].text,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
