import CDP from "chrome-remote-interface";
import { randomUUID } from "node:crypto";
import type { Protocol } from "devtools-protocol";
import {
  ObservationError,
  ElectronTargetSchema,
  InspectorConnectionSchema,
  type CdpAdapter,
  type CdpBinding,
  type CdpEvent,
  type CdpTarget,
  type ElectronTarget,
} from "../contracts.js";
import { assertEndpointOwner } from "../targets.js";
import { deadline } from "../util.js";
import { cdpVersions } from "./versions.js";

const electronExpression =
  'process.getBuiltinModule("module").createRequire(process.resourcesPath+"/app.asar/package.json")("electron")';

export interface ElectronInventory {
  pid: number;
  app: string;
  version: string;
  windows: Array<{
    id: number;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    webContentsId: number;
  }>;
  webContents: Array<{
    id: number;
    type: string;
    title: string;
    url: string;
    owner?: number;
    debuggerAttached: boolean;
  }>;
}
/** Read-only discovery for an explicitly supplied, PID-verified Inspector. */
export async function inspectElectron(input: {
  endpoint: string;
  expectedPid: number;
  timeoutMs?: number;
}): Promise<ElectronInventory> {
  const validated = InspectorConnectionSchema.parse(input);
  input = validated;
  const timeout = validated.timeoutMs;
  await assertEndpointOwner(input.endpoint, input.expectedPid);
  let expired = false;
  const connecting = CDP({ target: input.endpoint, local: true });
  connecting.then(
    (c) => {
      if (expired) void c.close();
    },
    () => undefined,
  );
  let client: CDP.Client;
  try {
    client = await deadline(connecting, timeout, "Inspector discovery");
  } catch (e) {
    expired = true;
    throw e;
  }
  try {
    const expression = `(()=>{if(process.pid!==${JSON.stringify(input.expectedPid)}||!process.versions.electron)throw Error('Unexpected Electron process');const e=${electronExpression};return {pid:process.pid,app:e.app.getName(),version:e.app.getVersion(),windows:e.BrowserWindow.getAllWindows().map(w=>({id:w.id,title:w.getTitle(),bounds:w.getBounds(),webContentsId:w.webContents.id})),webContents:e.webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType(),title:w.getTitle(),url:w.getURL(),owner:w.getOwnerBrowserWindow()?.id,debuggerAttached:w.debugger.isAttached()}))}})()`;
    const response = await deadline(
      client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      timeout,
      "Electron inventory",
    );
    if (response.exceptionDetails)
      throw new ObservationError(
        "ELECTRON_DISCOVERY_FAILED",
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    return response.result.value as ElectronInventory;
  } finally {
    await client.close();
  }
}

/** Node Inspector is only the transport to Electron's public debugger API.
 * No renderer debugging port, app patch, UI Console, or MCP client is used. */
export class ElectronCdpAdapter implements CdpAdapter {
  private client?: CDP.Client;
  private target?: ElectronTarget;
  private contextId?: number;
  private contexts = new Map<string, number>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private bindingName = `__radix_events_${randomUUID().replaceAll("-", "")}`;
  private stateKey = `__radix_capture_${randomUUID().replaceAll("-", "")}`;
  private initialized = false;
  private closed = false;
  private checkedMethods = new Set<string>();
  private event = (message: CDP.EventMessage) => {
    const params = message.params as Record<string, unknown>;
    if (
      this.closed ||
      message.method !== "Runtime.bindingCalled" ||
      params.name !== this.bindingName
    )
      return;
    try {
      const event = JSON.parse(String(params.payload)) as CdpEvent;
      if (event.method === "Runtime.executionContextCreated") {
        const context = event.params
          .context as Protocol.Runtime.ExecutionContextDescription;
        if (context.auxData?.isDefault && context.auxData.frameId)
          this.contexts.set(String(context.auxData.frameId), context.id);
      }
      for (const listener of this.listeners) listener(event);
    } catch (error) {
      for (const listener of this.listeners)
        listener({
          method: "Observation.disconnected",
          params: { reason: `Invalid event bridge: ${String(error)}` },
        });
    }
  };
  private async main<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return await deadline(
      (
        this.client as unknown as {
          send(method: string, params: Record<string, unknown>): Promise<T>;
        }
      ).send(method, params),
      this.target?.timeoutMs ?? 5000,
      `Node Inspector ${method}`,
    );
  }
  private async mainEvaluate<T>(expression: string): Promise<T> {
    const r = await this.main<Protocol.Runtime.EvaluateResponse>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (r.exceptionDetails)
      throw new ObservationError(
        "ELECTRON_EVALUATION_FAILED",
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
        "electron",
      );
    return r.result.value as T;
  }
  async connect(input: CdpTarget): Promise<CdpBinding> {
    if (this.client || this.closed)
      throw new ObservationError(
        "LIFECYCLE",
        "Use a new Electron adapter for each run",
      );
    this.target = ElectronTargetSchema.parse(input);
    const target = this.target;
    await assertEndpointOwner(target.endpoint, target.expectedPid);
    let expired = false;
    const connection = CDP({ target: target.endpoint, local: true });
    connection.then(
      (client) => {
        if (expired) void client.close();
      },
      () => undefined,
    );
    try {
      this.client = await deadline(
        connection,
        target.timeoutMs,
        "Node Inspector connect",
      );
    } catch (e) {
      expired = true;
      throw e;
    }
    this.client.on("event", this.event);
    this.client.on("disconnect", () => {
      if (!this.closed)
        for (const listener of this.listeners)
          listener({
            method: "Observation.disconnected",
            params: { reason: "Node Inspector disconnected" },
          });
    });
    await this.main("Runtime.enable");
    const identity = await this.mainEvaluate<{
      pid: number;
      versions: Record<string, string>;
    }>(
      "({pid:process.pid,versions:{node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome}})",
    );
    if (identity.pid !== target.expectedPid || !identity.versions.electron)
      throw new ObservationError(
        "ELECTRON_IDENTITY_MISMATCH",
        "Inspector is not the expected Electron process",
      );
    await this.main("Runtime.addBinding", { name: this.bindingName });
    const owner = await this.mainEvaluate<{
      title: string;
      bounds: { x: number; y: number; width: number; height: number };
      viewBounds: { x: number; y: number; width: number; height: number };
      appName: string;
      appVersion: string;
    }>(`(()=>{
      const electron=${electronExpression}, target=${JSON.stringify(target)}, key=${JSON.stringify(this.stateKey)}, binding=${JSON.stringify(this.bindingName)};
      const wc=electron.webContents.fromId(target.webContentsId), owner=electron.BrowserWindow.fromId(target.browserWindowId);
      if(!wc||wc.isDestroyed()||!owner||owner.isDestroyed()||wc.getOwnerBrowserWindow()!==owner||wc.getURL()!==target.expectedUrl||(target.expectedTitle!==undefined&&wc.getTitle()!==target.expectedTitle))throw Error('Exact renderer URL, title or owner mismatch');
      const matches=[];const visit=v=>{if(v.webContents?.id===wc.id)matches.push(v.getBounds());for(const child of v.children??[])visit(child)};visit(owner.contentView);
      if(wc===owner.webContents&&matches.length===0){const b=owner.getContentBounds();matches.push({x:0,y:0,width:b.width,height:b.height})}
      if(matches.length!==1)throw Error('Renderer is not uniquely owned by the selected window');
      if(wc.debugger.isAttached())throw Error('Renderer debugger already attached; existing debugger is not replaced');
      if(Object.hasOwn(globalThis,key))throw Error('Capture key already exists');
      const send=data=>globalThis[binding](JSON.stringify(data));
      const state={wc,owner,attached:false,disposed:false};
      const message=(_event,method,params,sessionId)=>{if(state.attached)send({method,params,...(sessionId?{sessionId}:{})})};
      const detached=(_event,reason)=>{if(!state.attached)return;state.attached=false;send({method:'Observation.disconnected',params:{reason}})};
      state.dispose=()=>{if(state.disposed)return;state.disposed=true;wc.debugger.removeListener('message',message);wc.debugger.removeListener('detach',detached);if(state.attached&&!wc.isDestroyed()&&wc.debugger.isAttached())wc.debugger.detach();delete globalThis[key]};
      globalThis[key]=state;wc.debugger.on('message',message);wc.debugger.on('detach',detached);
      try{wc.debugger.attach('1.3');state.attached=true}catch(error){state.dispose();throw error}
      return {title:owner.getTitle(),bounds:owner.getBounds(),viewBounds:matches[0],appName:electron.app.getName(),appVersion:electron.app.getVersion()};
    })()`);
    this.initialized = true;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("CSS.enable");
    const info = await this.send<Protocol.Target.GetTargetInfoResponse>(
      "Target.getTargetInfo",
    );
    if (info.targetInfo.url !== target.expectedUrl)
      throw new ObservationError(
        "TARGET_MISMATCH",
        "Renderer changed while attaching",
      );
    const tree =
      await this.send<Protocol.Page.GetFrameTreeResponse>("Page.getFrameTree");
    const frame = tree.frameTree.frame;
    if (
      (target.frameId && frame.id !== target.frameId) ||
      (target.expectedFrameUrl && frame.url !== target.expectedFrameUrl)
    )
      throw new ObservationError(
        "FRAME_MISMATCH",
        "Exact root frame did not match",
      );
    this.contextId = this.contexts.get(frame.id);
    if (this.contextId === undefined)
      throw new ObservationError(
        "CONTEXT_MISSING",
        "No default context for the exact Electron renderer",
      );
    const domains = await this.send("Schema.getDomains");
    return {
      targetId: info.targetInfo.targetId,
      frameId: frame.id,
      documentId: frame.loaderId,
      url: frame.url,
      title: info.targetInfo.title,
      browser: {
        runtime: identity,
        app: { name: owner.appName, version: owner.appVersion },
        sdk: await cdpVersions(),
        transport:
          "Node Inspector Runtime -> Electron webContents.debugger SDK",
      },
      protocol: {
        domains,
        checkedMethods: [...this.checkedMethods],
        supportBasis:
          "Only successful runtime commands; installed protocol typings are not capability evidence",
      },
      endpoint: target.endpoint,
      window: {
        id: target.browserWindowId,
        title: owner.title,
        bounds: owner.bounds,
      },
      owner: {
        kind: "electron-web-contents",
        pid: identity.pid,
        browserWindowId: target.browserWindowId,
        webContentsId: target.webContentsId,
        viewBounds: owner.viewBounds,
      },
    };
  }
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed || !this.initialized || !this.client)
      throw new ObservationError(
        "NOT_CONNECTED",
        "Electron renderer session is not available",
      );
    if (method === "Runtime.evaluate" && this.contextId !== undefined)
      params = { ...params, contextId: this.contextId };
    const result = await this.mainEvaluate<T>(
      `(()=>{const s=globalThis[${JSON.stringify(this.stateKey)}];if(!s||s.disposed||!s.attached||s.wc.isDestroyed()||!s.wc.debugger.isAttached())throw Error('Renderer binding ended');if(s.wc.getOwnerBrowserWindow()!==s.owner)throw Error('Renderer owner changed');return s.wc.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)});})()`,
    );
    this.checkedMethods.add(method);
    return result;
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send<Protocol.Runtime.EvaluateResponse>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (response.exceptionDetails)
      throw new ObservationError(
        "EVALUATION_FAILED",
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
        "renderer",
      );
    return response.result.value as T;
  }
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (!this.client) return;
    const errors: unknown[] = [];
    try {
      await this.mainEvaluate(
        `(()=>{globalThis[${JSON.stringify(this.stateKey)}]?.dispose();return true})()`,
      );
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.main("Runtime.removeBinding", { name: this.bindingName });
    } catch (e) {
      errors.push(e);
    }
    try {
      await this.mainEvaluate(
        `delete globalThis[${JSON.stringify(this.bindingName)}]`,
      );
    } catch (e) {
      errors.push(e);
    }
    await this.client.close();
    if (errors.length)
      throw new ObservationError(
        "ELECTRON_CLEANUP_UNCONFIRMED",
        errors.map(String).join(";"),
        "shutdown",
      );
  }
}
