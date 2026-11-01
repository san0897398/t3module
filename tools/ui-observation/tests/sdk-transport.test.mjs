import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DesktopHostSchema, ElectronTargetSchema } from "../dist/index.js";

test("explicit SDK host and Electron target identities cannot be omitted", () => {
  assert.throws(() =>
    DesktopHostSchema.parse({ mode: "daemon", socketPath: "/tmp/test.sock" }),
  );
  assert.throws(() =>
    DesktopHostSchema.parse({
      mode: "daemon",
      socketPath: "relative",
      expectedPid: 1,
      expectedVersion: "0.32.0",
    }),
  );
  assert.throws(() =>
    ElectronTargetSchema.parse({
      transport: "electron-inspector",
      endpoint: "ws://127.0.0.1:9229/id",
      expectedPid: 1,
      expectedUrl: "https://claude.ai/new",
    }),
  );
});

test(
  "actual Cua SDK sends native daemon requests, not MCP messages",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ui-sdk-wire-"));
    const socket = join(root, "host.sock");
    const requests = [];
    const server = createServer((connection) => {
      let input = "";
      connection.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        requests.push(request);
        let result;
        if (request.method === "metadata")
          result = {
            driver_version: "0.32.0",
            contract_version: "0.8.0",
            tools_list_schema_version: "1",
            capability_version: "1",
            mcp_protocol_version: "2025-06-18",
            pid: 123,
            embedded: false,
            host_bundle_id: "test.sdk.host",
          };
        else if (request.method === "call")
          result = {
            content: [],
            structuredContent:
              request.name === "list_apps"
                ? { apps: [] }
                : { pid: 123, window_id: 1, elements: [], truncated: false },
            isError: false,
          };
        else result = {};
        connection.end(JSON.stringify({ ok: true, result }) + "\n");
      });
    });
    await new Promise((r) => server.listen(socket, r));
    t.after(async () => {
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    // A separate process lets the SDK's synchronous native Drop close its IPC
    // session while this fixture server continues processing requests.
    const sdk = import.meta.resolve("@trycua/cua-driver");
    const code = `import {CuaDriver} from ${JSON.stringify(sdk)};const d=CuaDriver.connect(${JSON.stringify(socket)});try{await d.listApps({});const r=await d.callTool('get_window_state',JSON.stringify({pid:123,window_id:1}));if(r.isError)throw Error(r.text)}finally{await d.shutdown();d.uniffiDestroy()}`;
    await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", code],
      { timeout: 15000 },
    );
    assert.ok(
      requests.some((r) => r.method === "call" && r.name === "list_apps"),
    );
    assert.ok(
      requests.some(
        (r) => r.method === "call" && r.name === "get_window_state",
      ),
    );
    assert.ok(requests.some((r) => r.method === "session_end"));
    assert.ok(
      requests.every(
        (r) =>
          !("jsonrpc" in r) &&
          !r.method.startsWith("tools/") &&
          r.method !== "initialize",
      ),
    );
    assert.ok(
      requests
        .filter((r) => r.method === "call")
        .every(
          (r) =>
            r.observation_origin === "direct" &&
            r.client_kind === "typescript_sdk",
        ),
    );
  },
);
