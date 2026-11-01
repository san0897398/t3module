import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";
import {
  ObservationError,
  type CdpAdapter,
  type CdpBinding,
  type CdpEvent,
  type CdpTarget,
} from "../contracts.js";
import { deadline, hash, json } from "../util.js";
import { cdpVersions } from "./versions.js";

export function localEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new ObservationError(
      "ENDPOINT_NOT_LOCAL",
      "Provide an explicit loopback browser WebSocket endpoint",
      "cdp",
    );
  if (!url.pathname.startsWith("/devtools/browser/"))
    throw new ObservationError(
      "BROWSER_ENDPOINT_REQUIRED",
      "Use the browser WebSocket endpoint and explicit targetId; page endpoints are not silently substituted",
      "cdp",
    );
  return url;
}
export class ChromeCdpAdapter implements CdpAdapter {
  private client?: CDP.Client;
  private sessionId?: string;
  private contextId?: number;
  private timeoutMs = 5000;
  private closed = false;
  private listeners = new Set<(event: CdpEvent) => void>();
  private binding?: CdpBinding;
  private supported = new Set<string>();
  private contexts = new Map<string, number>();
  private rootEvent = (message: CDP.EventMessage) => {
    if (this.closed || message.sessionId !== this.sessionId) return;
    const params = message.params as Record<string, unknown>;
    if (message.method === "Runtime.executionContextCreated") {
      const c = params.context as Protocol.Runtime.ExecutionContextDescription;
      if (c.auxData?.isDefault && c.auxData.frameId)
        this.contexts.set(String(c.auxData.frameId), c.id);
    }
    for (const listener of this.listeners)
      listener({
        method: message.method,
        params,
        sessionId: message.sessionId,
      });
  };
  private async root<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return (await deadline(
      this.dynamicSend(method, params),
      this.timeoutMs,
      method,
    )) as T;
  }
  private dynamicSend(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    // Public adapter strings deliberately do not expose provider protocol types.
    return (
      this.client as unknown as {
        send(
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown>;
      }
    ).send(method, params, sessionId);
  }
  async connect(target: CdpTarget): Promise<CdpBinding> {
    if (target.transport === "electron-inspector")
      throw new ObservationError(
        "WRONG_ADAPTER",
        "Use ElectronCdpAdapter for an Electron Inspector endpoint",
      );
    if (this.client || this.closed)
      throw new ObservationError(
        "LIFECYCLE",
        "Use a new CDP adapter for each run",
      );
    const endpoint = localEndpoint(target.endpoint);
    this.timeoutMs = target.timeoutMs;
    // Read the actual protocol served by this endpoint, rather than using the
    // installed type package as evidence that a method exists.
    const protocolUrl = new URL("/json/protocol", endpoint);
    protocolUrl.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(protocolUrl, {
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    if (!response.ok)
      throw new ObservationError(
        "PROTOCOL_UNAVAILABLE",
        `Protocol HTTP ${response.status}`,
        "cdp",
      );
    const protocol = (await response.json()) as CDP.Protocol;
    if (!Array.isArray(protocol.domains))
      throw new ObservationError(
        "INVALID_PROTOCOL",
        "No runtime protocol domains",
      );
    for (const domain of protocol.domains)
      for (const command of domain.commands ?? [])
        this.supported.add(`${domain.domain}.${command.name}`);
    for (const method of [
      "Target.attachToTarget",
      "Runtime.evaluate",
      "Page.captureScreenshot",
      "DOM.getDocument",
      "CSS.getMatchedStylesForNode",
    ]) {
      if (!this.supported.has(method))
        throw new ObservationError("UNSUPPORTED_METHOD", method, "cdp");
    }
    // Close late connection results as well; a timeout never leaks a socket.
    let expired = false;
    const connection = CDP({ target: endpoint.href, protocol });
    connection.then(
      (client) => {
        if (expired) void client.close();
      },
      () => undefined,
    );
    try {
      this.client = await deadline(connection, this.timeoutMs, "CDP.connect");
    } catch (error) {
      expired = true;
      throw error;
    }
    this.client.on("event", this.rootEvent);
    this.client.on("disconnect", () => {
      for (const l of this.listeners)
        l({ method: "Observation.disconnected", params: {} });
    });
    const targets =
      await this.root<Protocol.Target.GetTargetsResponse>("Target.getTargets");
    const found = targets.targetInfos.filter(
      (t) =>
        t.targetId === target.targetId &&
        t.url === target.expectedUrl &&
        (target.expectedTitle === undefined ||
          t.title === target.expectedTitle),
    );
    if (
      found.length !== 1 ||
      !["page", "iframe", "webview"].includes(found[0]!.type)
    )
      throw new ObservationError(
        "TARGET_MISMATCH",
        "The explicit target ID, URL, title or type did not match",
        "cdp",
      );
    this.sessionId = (
      await this.root<Protocol.Target.AttachToTargetResponse>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      )
    ).sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("CSS.enable");
    const tree =
      await this.send<Protocol.Page.GetFrameTreeResponse>("Page.getFrameTree");
    const frames: Protocol.Page.Frame[] = [];
    const visit = (node: Protocol.Page.FrameTree) => {
      frames.push(node.frame);
      node.childFrames?.forEach(visit);
    };
    visit(tree.frameTree);
    const frame = frames.find(
      (f) => f.id === (target.frameId ?? tree.frameTree.frame.id),
    );
    if (
      !frame ||
      (target.expectedFrameUrl !== undefined &&
        frame.url !== target.expectedFrameUrl)
    )
      throw new ObservationError(
        "FRAME_MISMATCH",
        "Explicit frame not found in this target; OOPIF requires its own target/session",
        "cdp",
      );
    if (frame.id !== tree.frameTree.frame.id)
      throw new ObservationError(
        "FRAME_CAPTURE_UNSUPPORTED",
        "Child-frame coordinate-to-root-screenshot mapping is not implemented; provide an explicit renderer target for that frame instead of mixing coordinate spaces",
        "cdp",
      );
    this.contextId = this.contexts.get(frame.id);
    if (this.contextId === undefined)
      throw new ObservationError(
        "CONTEXT_MISSING",
        "No default execution context for the exact frame",
        "cdp",
      );
    const browser =
      await this.root<Protocol.Browser.GetVersionResponse>(
        "Browser.getVersion",
      );
    let window: CdpBinding["window"] = null;
    try {
      const w = await this.root<Protocol.Browser.GetWindowForTargetResponse>(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
      );
      if (
        w.bounds.left !== undefined &&
        w.bounds.top !== undefined &&
        w.bounds.width !== undefined &&
        w.bounds.height !== undefined
      )
        window = {
          id: w.windowId,
          bounds: {
            x: w.bounds.left,
            y: w.bounds.top,
            width: w.bounds.width,
            height: w.bounds.height,
          },
        };
    } catch {
      /* headless/embedded capability is explicitly absent */
    }
    this.binding = {
      targetId: target.targetId,
      frameId: frame.id,
      documentId: frame.loaderId,
      url: frame.url,
      title: found[0]!.title,
      sessionId: this.sessionId,
      browser: { runtime: browser, sdk: await cdpVersions() },
      protocol: {
        version: protocol.version,
        sha256: hash(json(protocol)),
        methods: [...this.supported].sort(),
      },
      endpoint: endpoint.href,
      window,
    };
    return this.binding;
  }
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed || !this.client || !this.sessionId)
      throw new ObservationError(
        "NOT_CONNECTED",
        "CDP session is not available",
        "cdp",
      );
    if (!this.supported.has(method))
      throw new ObservationError("UNSUPPORTED_METHOD", method, "cdp");
    if (method === "Runtime.evaluate" && this.contextId !== undefined)
      params = { ...params, contextId: this.contextId };
    return (await deadline(
      this.dynamicSend(method, params, this.sessionId),
      this.timeoutMs,
      method,
    )) as T;
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.send<Protocol.Runtime.EvaluateResponse>(
      "Runtime.evaluate",
      {
        expression,
        contextId: this.contextId,
        returnByValue: true,
        awaitPromise: true,
      },
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
    if (this.client) await this.client.close();
  }
}
