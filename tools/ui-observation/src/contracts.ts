import { z } from "zod";

export const FORMAT = "radix-ui-observation/1" as const;
export const TRANSFORMER = "radix-ui-reference/1" as const;
const text = z.string().min(1);
const finite = z.number().finite();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const RectSchema = z.object({
  x: finite,
  y: finite,
  width: finite.nonnegative(),
  height: finite.nonnegative(),
});
export type Rect = z.infer<typeof RectSchema>;
export const DesktopTargetSchema = z
  .object({
    bundleId: text,
    pid: z.number().int().positive().optional(),
    windowId: z.string().regex(/^\d+$/).optional(),
    title: text,
  })
  .strict();
export const DesktopHostSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("embedded") }).strict(),
  z
    .object({
      mode: z.literal("daemon"),
      socketPath: text.startsWith("/"),
      expectedPid: z.number().int().positive(),
      expectedVersion: text,
    })
    .strict(),
]);
export type DesktopHost = z.infer<typeof DesktopHostSchema>;
export const InspectorConnectionSchema = z
  .object({
    endpoint: z.string().url(),
    expectedPid: z.number().int().positive(),
    timeoutMs: z.number().int().min(100).max(60000).default(5000),
  })
  .strict();
export const BrowserCdpTargetSchema = z
  .object({
    transport: z.literal("browser").default("browser"),
    endpoint: z.string().url(),
    targetId: text,
    expectedUrl: text,
    frameId: text.optional(),
    expectedFrameUrl: text.optional(),
    expectedTitle: text.optional(),
    timeoutMs: z.number().int().min(100).max(60000).default(5000),
  })
  .strict();
export const ElectronTargetSchema = z
  .object({
    ...InspectorConnectionSchema.shape,
    transport: z.literal("electron-inspector"),
    browserWindowId: z.number().int().positive(),
    webContentsId: z.number().int().positive(),
    expectedUrl: text,
    expectedTitle: text.optional(),
    frameId: text.optional(),
    expectedFrameUrl: text.optional(),
  })
  .strict();
export const CdpTargetSchema = z.union([
  BrowserCdpTargetSchema,
  ElectronTargetSchema,
]);
export type ElectronTarget = z.infer<typeof ElectronTargetSchema>;
export const ElementSchema = z
  .object({
    key: text,
    selector: text,
    properties: z.array(text).min(1),
    attributes: z.array(text).default([]),
    pseudos: z.array(z.enum(["::before", "::after"])).default([]),
    ancestors: z.number().int().min(0).max(20).default(0),
  })
  .strict();
export const ConditionSchema = z
  .object({
    selector: text,
    attribute: text.optional(),
    equals: z.string().optional(),
    textIncludes: z.string().optional(),
    timeoutMs: z.number().int().min(50).max(60000).default(5000),
  })
  .strict();
export const ActionSchema = z
  .object({
    kind: z.enum(["cdp-click", "desktop-click"]),
    selector: text,
    delivery: z.enum(["foreground", "background"]).optional(),
    after: ConditionSchema,
  })
  .strict()
  .refine(
    (a) => a.kind !== "desktop-click" || a.delivery !== undefined,
    "Desktop input requires an explicit delivery mode",
  );
export const SceneSchema = z
  .object({
    version: z.literal(1),
    id: text,
    revision: text,
    desktopHost: DesktopHostSchema.default({ mode: "embedded" }),
    target: z
      .object({
        desktop: DesktopTargetSchema.optional(),
        cdp: CdpTargetSchema.optional(),
      })
      .strict()
      .refine((t) => t.desktop || t.cdp, "An explicit target is required"),
    elements: z.array(ElementSchema).default([]),
    conditions: z
      .object({
        viewport: z
          .object({ width: finite.positive(), height: finite.positive() })
          .optional(),
        dpr: finite.positive().optional(),
        theme: z.enum(["light", "dark"]).optional(),
        reducedMotion: z.boolean().optional(),
        density: text,
        dataState: text,
        fontState: text,
      })
      .strict(),
    ready: ConditionSchema.optional(),
    entry: z.array(ActionSchema).default([]),
    actions: z.array(ActionSchema).default([]),
    durationMs: z.number().int().min(0).max(120000).default(10000),
    frameIntervalMs: z.number().int().min(50).max(10000).default(100),
    maxSampleGapMs: finite.positive().default(100),
    fullDocument: z.boolean().default(false),
    maxRecords: z.number().int().min(10).max(100000).default(10000),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (new Set(s.elements.map((e) => e.key)).size !== s.elements.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate semantic element key",
      });
    if (s.target.cdp && !s.elements.length)
      ctx.addIssue({
        code: "custom",
        message: "CDP scenes require bounded element selectors",
      });
    for (const a of [...s.entry, ...s.actions]) {
      if (a.kind === "cdp-click" && !s.target.cdp)
        ctx.addIssue({
          code: "custom",
          message: "CDP action without CDP target",
        });
      if (a.kind === "desktop-click" && !s.target.desktop)
        ctx.addIssue({
          code: "custom",
          message: "Desktop action without desktop target",
        });
    }
  });
export type Scene = z.infer<typeof SceneSchema>;
export type ElementSpec = z.infer<typeof ElementSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type CdpTarget = z.infer<typeof CdpTargetSchema>;
export type DesktopTarget = z.infer<typeof DesktopTargetSchema>;

export const IssueSchema = z.object({ code: text, message: text, scope: text });
export type Issue = z.infer<typeof IssueSchema>;
export const TimeSchema = z.object({
  hostMs: finite,
  rendererMs: finite.optional(),
  rendererTimeOriginMs: finite.optional(),
  requestStartMs: finite.optional(),
  requestEndMs: finite.optional(),
});
export type Time = z.infer<typeof TimeSchema>;
export const ScopeSchema = z.object({
  runId: text,
  targetId: text,
  frameId: text,
  documentId: text,
  segment: z.number().int().nonnegative(),
});
export type Scope = z.infer<typeof ScopeSchema>;
export const FactSchema = z.object({
  id: text,
  element: text,
  property: text,
  value: z.json(),
  unit: text,
  scope: ScopeSchema,
  time: TimeSchema,
  provenance: z.object({
    kind: z.enum(["observed", "source", "calculated", "estimated", "unknown"]),
    method: text,
    evidence: z.array(text),
    reason: text.optional(),
  }),
});
export type Fact = z.infer<typeof FactSchema>;
export const FrameSchema = z.object({
  path: text,
  channel: z.enum(["renderer", "os"]),
  time: TimeSchema,
  mimeType: z.enum(["image/png", "image/jpeg"]).default("image/png"),
  scope: ScopeSchema,
  width: finite.positive(),
  height: finite.positive(),
});
export type Frame = z.infer<typeof FrameSchema>;
export const ValidationSchema = z.object({
  id: text,
  status: z.enum(["pass", "fail", "unknown"]),
  reason: text,
  evidence: z.array(text),
});
export type Validation = z.infer<typeof ValidationSchema>;
export const FileSchema = z.object({
  path: text,
  bytes: z.number().int().nonnegative(),
  sha256: sha,
});
export const ManifestSchema = z
  .object({
    format: z.literal(FORMAT),
    runId: text,
    sceneId: text,
    sceneHash: sha,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    outcome: z.enum(["completed", "partial", "cancelled", "failed"]),
    channels: z.array(z.enum(["renderer", "os", "ax"])),
    files: z.array(FileSchema),
    issues: z.array(IssueSchema),
    records: z.object({
      accepted: z.number().int(),
      written: z.number().int(),
      dropped: z.number().int(),
      lastSequence: z.number().int(),
    }),
    validation: z.array(ValidationSchema),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export interface RecordEntry {
  sequence: number;
  receivedHostMs: number;
  channel: "events" | "samples" | "actions";
  data: unknown;
}

export interface Clock {
  now(): number;
  date(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface DesktopBinding {
  app: { pid: number; bundleId: string; version: string | null; path?: string };
  window: { id: string; title: string; bounds: Rect };
  sdk: unknown;
  permissions: unknown;
}
export interface DesktopSnapshot {
  raw: unknown;
  image?: Uint8Array;
  mimeType?: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  axAvailable: boolean;
  issues: Issue[];
}
export interface DesktopAdapter {
  connect(target: DesktopTarget): Promise<DesktopBinding>;
  snapshot(): Promise<DesktopSnapshot>;
  click(
    selector: string,
    delivery: "foreground" | "background",
  ): Promise<{
    delivery: "acknowledged" | "unknown" | "refused";
    raw: unknown;
  }>;
  close(): Promise<void>;
}
export interface CdpBinding {
  targetId: string;
  frameId: string;
  documentId: string;
  url: string;
  title: string;
  sessionId?: string;
  browser: unknown;
  protocol: unknown;
  endpoint: string;
  window: { bounds: Rect; id: number; title?: string } | null;
  owner?: {
    kind: "electron-web-contents";
    pid: number;
    browserWindowId: number;
    webContentsId: number;
    viewBounds: Rect;
  };
}
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
export interface CdpAdapter {
  connect(target: CdpTarget): Promise<CdpBinding>;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): Promise<void>;
}
export interface RuntimeDependencies {
  desktop?: () => DesktopAdapter;
  cdp?: () => CdpAdapter;
  clock?: Clock;
  writer?: (
    root: string,
    runId: string,
    scene: Scene,
    clock: Clock,
  ) => Promise<BundleWriterPort>;
}
export interface BundleWriterPort {
  path: string;
  runId: string;
  write(path: string, value: unknown): Promise<void>;
  bytes(path: string, data: Uint8Array): Promise<void>;
  record(channel: RecordEntry["channel"], data: unknown): boolean;
  drain(): Promise<void>;
  finish(
    result: Pick<Manifest, "outcome" | "channels" | "issues" | "validation">,
  ): Promise<{ path: string; manifest: Manifest }>;
}
export const QuerySchema = z
  .object({
    elements: z.array(text).optional(),
    properties: z.array(text).optional(),
    kinds: z.array(FactSchema.shape.provenance.shape.kind).optional(),
    fromMs: finite.optional(),
    toMs: finite.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    maxBytes: z.number().int().min(256).max(1048576).default(65536),
    cursor: text.optional(),
  })
  .strict()
  .refine(
    (q) => q.fromMs === undefined || q.toMs === undefined || q.fromMs <= q.toMs,
    "Reversed time range",
  );
export type Query = z.infer<typeof QuerySchema>;
export const SourceFactSchema = z
  .object({
    element: text,
    property: text,
    value: z.json(),
    unit: text,
    path: text,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    sha256: sha,
    revision: text,
    actor: text,
    method: text,
    conditions: text,
    loadedAssetSha256: sha.optional(),
  })
  .strict()
  .refine((s) => s.startLine <= s.endLine, "Invalid source range");
export type SourceFact = z.infer<typeof SourceFactSchema>;
export const IntentSchema = z
  .object({
    task: text,
    owner: text,
    conditions: z
      .array(
        z.enum([
          "viewport",
          "dpr",
          "theme",
          "reducedMotion",
          "density",
          "dataState",
          "fontState",
          "fonts",
          "scroll",
          "zoom",
        ]),
      )
      .min(1),
    checks: z
      .array(
        z
          .object({
            id: text,
            intent: z.enum(["maintain", "change"]),
            referenceElement: text,
            implementationElement: text,
            property: text,
            tolerance: finite.nonnegative().default(0),
            expected: z.json().optional(),
            reason: text,
          })
          .strict(),
      )
      .min(1),
    humanReview: text,
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (new Set(intent.checks.map((c) => c.id)).size !== intent.checks.length)
      ctx.addIssue({ code: "custom", message: "Duplicate check ID" });
    if (
      intent.checks.some(
        (c) => c.intent === "change" && c.expected === undefined,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Change checks require a predetermined expected value",
      });
  });
export type Intent = z.infer<typeof IntentSchema>;

export class ObservationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly scope = "run",
  ) {
    super(message);
    this.name = "ObservationError";
  }
}
export function issue(error: unknown, scope = "run"): Issue {
  const foreign =
    typeof error === "object" && error !== null && "inner" in error
      ? error.inner
      : undefined;
  const detail =
    typeof foreign === "object" && foreign !== null
      ? ["message", "reason"]
          .map((key) => (foreign as Record<string, unknown>)[key])
          .find((value) => typeof value === "string" && value.length > 0)
      : undefined;
  return error instanceof ObservationError
    ? { code: error.code, message: error.message, scope: error.scope }
    : {
        code: "ERROR",
        message:
          error instanceof Error && error.message
            ? error.message
            : typeof detail === "string"
              ? detail
              : String(error),
        scope,
      };
}
