import * as z from "zod/v4";

export const ERROR_CATEGORIES = [
  "VALIDATION_ERROR",
  "LIMIT_EXCEEDED",
  "BRIDGE_UNAVAILABLE",
  "AUTH_FAILED",
  "VERSION_UNSUPPORTED",
  "PROTOCOL_UNSUPPORTED",
  "CAPABILITY_UNAVAILABLE",
  "CAPABILITY_UNVERIFIED",
  "MAP_NOT_FOUND",
  "NODE_NOT_FOUND",
  "REVISION_CONFLICT",
  "SELECTION_CONFLICT",
  "CURSOR_EXPIRED",
  "CURSOR_INSTANCE_MISMATCH",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_STALE",
  "POLICY_DENIED",
  "PATH_DENIED",
  "FILE_CONFLICT",
  "XML_UNSAFE",
  "XML_INVALID",
  "ROUNDTRIP_UNSAFE",
  "ACTION_PRECONDITION_FAILED",
  "FREEPLANE_ERROR",
  "TIMEOUT",
  "POSTCONDITION_FAILED",
  "ROLLBACK_FAILED",
  "RECOVERY_REQUIRED",
  "EXPORT_VERIFICATION_FAILED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_RECONCILIATION_REQUIRED",
  "SECURE_INPUT_UNAVAILABLE",
  "INDETERMINATE_AFTER_CRASH",
] as const;

export const ErrorCategorySchema = z.enum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const EffectStatusSchema = z.enum([
  "none",
  "planned",
  "verified",
  "not_observed",
  "diverged",
  "indeterminate",
]);

export const AuthoritySchema = z.enum(["bridge", "file"]);
export const RouteKindSchema = z.enum([
  "public_api",
  "internal_api",
  "menu",
  "gui",
  "file",
]);
export const CapabilityStatusSchema = z.enum([
  "verified_public_api",
  "verified_internal_api",
  "verified_menu",
  "verified_gui",
  "file_read",
  "file_write",
  "needs_validation",
  "unsupported",
]);
export const CapabilityRiskSchema = z.enum(["normal", "confirm", "blocked"]);

export const RevisionSchema = z
  .object({
    content_revision: z.int().nonnegative(),
    view_revision: z.int().nonnegative(),
  })
  .strict();

export const RouteSchema = z
  .object({
    kind: RouteKindSchema,
    capability_id: z.string().min(1),
    validation_status: CapabilityStatusSchema,
  })
  .strict();

export const ToolErrorSchema = z
  .object({
    category: ErrorCategorySchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    readback: z.unknown().nullable(),
    events: z.array(z.unknown()),
    artifact: z.unknown().nullable(),
  })
  .strict();

export const ResponseEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    effect_status: EffectStatusSchema,
    authority: AuthoritySchema,
    bridge_instance_id: z.string().min(1).nullable(),
    map_id: z.string().min(1).nullable(),
    before: RevisionSchema.nullable(),
    after: RevisionSchema.nullable(),
    route: RouteSchema.nullable(),
    data: z.unknown(),
    evidence: EvidenceSchema,
    warnings: z.array(z.string()),
    error: ToolErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok === (value.error !== null)) {
      context.addIssue({
        code: "custom",
        message: "ok responses cannot contain an error; failed responses require one",
        path: ["error"],
      });
    }
  });

export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

export const CapabilitySchema = z
  .object({
    capability_id: z.string().min(1),
    scope: z.enum(["read", "edit", "document", "view", "export", "gui"]),
    status: CapabilityStatusSchema,
    route: RouteKindSchema,
    risk: CapabilityRiskSchema,
    freeplane_version: z.string().min(1),
    qualification_report: z.string().min(1),
    evidence: z.array(z.string()),
  })
  .strict();

export const CapabilityManifestSchema = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.iso.datetime(),
    freeplane_version: z.string().min(1),
    freeplane_build_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    addon_version: z.string().nullable(),
    protocol_revision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capabilities: z.array(CapabilitySchema),
  })
  .strict();

export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export const StatusInputSchema = z
  .object({
    include_active_map: z.boolean().default(true),
    include_diagnostics: z.boolean().default(false),
  })
  .strict();

export const CapabilitiesInputSchema = z
  .object({
    scope: z
      .enum(["all", "read", "edit", "document", "view", "export", "gui"])
      .default("all"),
  })
  .strict();

export const ListMapsInputSchema = z
  .object({
    include_closed_recent: z.boolean().default(false),
  })
  .strict();

export const ReadFieldSchema = z.enum([
  "text",
  "details",
  "note",
  "attributes",
  "tags",
  "icons",
  "links",
  "connectors",
  "style",
  "layout",
  "timestamps",
  "encryption",
]);

const DEFAULT_READ_FIELDS = [
  "text",
  "details",
  "note",
  "attributes",
  "tags",
  "icons",
  "links",
  "connectors",
  "style",
  "layout",
  "timestamps",
  "encryption",
] as const;

export const ReadInputSchema = z
  .object({
    map_id: z.string().min(1).max(512).optional(),
    scope: z.enum(["map", "subtree", "nodes", "selection"]).default("map"),
    root_node_id: z.string().min(1).max(512).optional(),
    node_ids: z.array(z.string().min(1).max(512)).max(5_000).default([]),
    depth: z.int().min(0).max(1_000).default(3),
    fields: z.array(ReadFieldSchema).max(DEFAULT_READ_FIELDS.length).default([...DEFAULT_READ_FIELDS]),
    include_effective_style: z.literal(false).default(false),
    max_nodes: z.int().min(1).max(5_000).default(1_000),
    page_cursor: z.string().min(1).max(2_048).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope !== "selection" && !value.map_id) {
      context.addIssue({ code: "custom", message: "map_id is required for this scope", path: ["map_id"] });
    }
    if (value.scope === "subtree" && !value.root_node_id) {
      context.addIssue({
        code: "custom",
        message: "root_node_id is required for subtree scope",
        path: ["root_node_id"],
      });
    }
    if (value.scope === "nodes" && value.node_ids.length === 0) {
      context.addIssue({ code: "custom", message: "node_ids cannot be empty", path: ["node_ids"] });
    }
    if (new Set(value.fields).size !== value.fields.length) {
      context.addIssue({ code: "custom", message: "fields cannot contain duplicates", path: ["fields"] });
    }
  });

export const SearchInputSchema = z
  .object({
    map_id: z.string().min(1).max(512),
    scope: z
      .object({
        root_node_id: z.string().min(1).max(512).nullable().default(null),
        include_descendants: z.boolean().default(true),
      })
      .strict()
      .default({ root_node_id: null, include_descendants: true }),
    query: z
      .object({
        text: z
          .object({
            mode: z.literal("literal"),
            value: z.string().min(1).max(512),
            case_sensitive: z.boolean().default(false),
          })
          .strict(),
      })
      .strict(),
    max_results: z.int().min(1).max(1_000).default(200),
    include_snippets: z.boolean().default(true),
  })
  .strict();

export const ChangesInputSchema = z
  .object({
    cursor: z.string().min(1).max(512).nullable().default(null),
    map_id: z.string().min(1).max(512).nullable().default(null),
    limit: z.int().min(1).max(1_000).default(1_000),
    wait_ms: z.int().min(0).max(750).default(0),
  })
  .strict();

const NodeReferenceSchema = z.string().min(1).max(512);
const ContentTextSchema = z.string().max(100_000);
const TemporaryNodeIdSchema = z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/);

const NodeContentSchema = z
  .object({
    text: ContentTextSchema.optional(),
    details: ContentTextSchema.optional(),
    note: ContentTextSchema.optional(),
  })
  .strict();

const ConnectorPropertiesSchema = z
  .object({
    shape: z.enum(["LINE", "LINEAR_PATH", "CUBIC_CURVE", "EDGE_LIKE"]).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    width: z.int().min(1).max(32).optional(),
    start_arrow: z.boolean().optional(),
    end_arrow: z.boolean().optional(),
    source_label: z.string().max(1_000).optional(),
    middle_label: z.string().max(1_000).optional(),
    target_label: z.string().max(1_000).optional(),
  })
  .strict();

const SafeStyleSchema = z
  .object({
    background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    text_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    font_size: z.int().min(6).max(144).optional(),
    node_shape: z.enum(["FORK", "BUBBLE", "OVAL", "RECTANGLE", "WIDE_HEXAGON", "NARROW_HEXAGON"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "style requires at least one property" });

const SafeLayoutSchema = z
  .object({
    child_nodes: z.enum([
      "TOPTOBOTTOM_BOTHSIDES_CENTERED",
      "TOPTOBOTTOM_RIGHT_CENTERED",
      "LEFTTORIGHT_BOTHSIDES_CENTERED",
      "LEFTTORIGHT_BOTTOM_CENTERED",
      "AUTO",
    ]).optional(),
    horizontal_shift: z.int().min(-10_000).max(10_000).optional(),
    vertical_shift: z.int().min(-10_000).max(10_000).optional(),
    minimal_distance_between_children: z.int().min(0).max(10_000).optional(),
    base_distance_to_children: z.int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "layout requires at least one property" });

export const ApplyOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_node"),
    temp_id: TemporaryNodeIdSchema,
    parent_id: NodeReferenceSchema,
    index: z.int().nonnegative(),
    content: NodeContentSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("update_content"),
    node_id: NodeReferenceSchema,
    text: ContentTextSchema.optional(),
    details: ContentTextSchema.optional(),
    note: ContentTextSchema.optional(),
  }).strict().refine(
    (value) => value.text !== undefined || value.details !== undefined || value.note !== undefined,
    { message: "update_content requires text, details, or note" },
  ),
  z.object({
    op: z.literal("set_attributes"),
    node_id: NodeReferenceSchema,
    attributes: z.array(z.object({
      name: z.string().min(1).max(1_000),
      value: ContentTextSchema,
    }).strict()).max(1_000),
  }).strict(),
  z.object({
    op: z.literal("set_tags"),
    node_id: NodeReferenceSchema,
    tags: z.array(z.string().min(1).max(1_000)).max(100),
  }).strict(),
  z.object({
    op: z.literal("set_icons"),
    node_id: NodeReferenceSchema,
    icons: z.array(z.string().min(1).max(256)).max(100),
  }).strict(),
  z.object({
    op: z.literal("set_link"),
    node_id: NodeReferenceSchema,
    link: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("uri"), uri: z.url().max(8_192) }).strict(),
      z.object({ kind: z.literal("node"), target_node_id: NodeReferenceSchema }).strict(),
      z.object({ kind: z.literal("text"), value: z.string().min(1).max(8_192) }).strict(),
    ]),
  }).strict(),
  z.object({
    op: z.literal("move_node"),
    node_id: NodeReferenceSchema,
    parent_id: NodeReferenceSchema,
    index: z.int().nonnegative(),
  }).strict(),
  z.object({
    op: z.literal("reorder_children"),
    parent_id: NodeReferenceSchema,
    child_ids: z.array(NodeReferenceSchema).max(10_000),
  }).strict().refine((value) => new Set(value.child_ids).size === value.child_ids.length, {
    message: "child_ids cannot contain duplicates",
  }),
  z.object({
    op: z.literal("delete_nodes"),
    node_ids: z.array(NodeReferenceSchema).min(1).max(500),
  }).strict().refine((value) => new Set(value.node_ids).size === value.node_ids.length, {
    message: "node_ids cannot contain duplicates",
  }),
  z.object({
    op: z.literal("set_folded"),
    node_id: NodeReferenceSchema,
    folded: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("add_connector"),
    source_id: NodeReferenceSchema,
    target_id: NodeReferenceSchema,
    properties: ConnectorPropertiesSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("update_connector"),
    connector_id: z.string().regex(/^fpconn:[a-f0-9]{64}$/),
    properties: ConnectorPropertiesSchema.refine(
      (value) => Object.keys(value).length > 0,
      { message: "update_connector requires at least one property" },
    ),
  }).strict(),
  z.object({
    op: z.literal("remove_connector"),
    connector_ids: z.array(z.string().regex(/^fpconn:[a-f0-9]{64}$/)).min(1).max(500),
  }).strict().refine((value) => new Set(value.connector_ids).size === value.connector_ids.length, {
    message: "connector_ids cannot contain duplicates",
  }),
  z.object({
    op: z.literal("clone_node"),
    temp_id: TemporaryNodeIdSchema,
    source_id: NodeReferenceSchema,
    parent_id: NodeReferenceSchema,
    index: z.int().nonnegative(),
    with_subtree: z.literal(false).default(false),
  }).strict(),
  z.object({
    op: z.literal("create_summary"),
    temp_id: TemporaryNodeIdSchema,
    parent_id: NodeReferenceSchema,
    first_child_id: NodeReferenceSchema,
    last_child_id: NodeReferenceSchema,
    text: ContentTextSchema,
  }).strict(),
  z.object({
    op: z.literal("set_free"),
    node_id: NodeReferenceSchema,
    free: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("set_side"),
    node_id: NodeReferenceSchema,
    side: z.enum(["LEFT", "RIGHT"]),
  }).strict(),
  z.object({
    op: z.literal("set_style"),
    node_id: NodeReferenceSchema,
    style: SafeStyleSchema,
  }).strict(),
  z.object({
    op: z.literal("set_layout"),
    node_id: NodeReferenceSchema,
    layout: SafeLayoutSchema,
  }).strict(),
  z.object({
    op: z.literal("set_cloud"),
    node_id: NodeReferenceSchema,
    enabled: z.boolean(),
    shape: z.enum(["ARC", "STAR", "RECT", "ROUND_RECT"]).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }).strict(),
  z.object({
    op: z.literal("set_bookmark"),
    node_id: NodeReferenceSchema,
    bookmark: z.discriminatedUnion("action", [
      z.object({ action: z.literal("remove") }).strict(),
      z.object({
        action: z.literal("set"),
        name: z.string().min(1).max(256),
        type: z.enum(["SELECT", "ROOT"]),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    op: z.literal("set_formula"),
    node_id: NodeReferenceSchema,
    expression: z.string().min(2).max(256).regex(/^=[0-9+\-*/().%\s]+$/).refine(
      (value) => /\d/.test(value),
      { message: "formula requires at least one digit" },
    ),
  }).strict(),
  z.object({
    op: z.literal("set_reminder"),
    node_id: NodeReferenceSchema,
    reminder: z.discriminatedUnion("action", [
      z.object({ action: z.literal("remove") }).strict(),
      z.object({
        action: z.literal("set"),
        at: z.iso.datetime(),
        period_unit: z.enum(["MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]),
        period: z.int().min(1).max(10_000),
      }).strict(),
    ]),
  }).strict(),
]);

export const ConfirmationSchema = z
  .object({
    confirmation_id: z.string().min(1).max(256),
    accepted: z.literal(true),
  })
  .strict();

export const ApplyInputSchema = z
  .object({
    map_id: z.string().min(1).max(512),
    expected_content_revision: z.int().nonnegative(),
    expected_file_revision: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    expected_view_revision: z.int().nonnegative().nullable().default(null),
    idempotency_key: z.uuid(),
    dry_run: z.boolean().default(true),
    operations: z.array(ApplyOperationSchema).min(1).max(500),
    confirmation: ConfirmationSchema.nullable().default(null),
    user_summary: z.string().min(1).max(1_000),
  })
  .strict();

export type ApplyOperation = z.infer<typeof ApplyOperationSchema>;
export type ApplyInput = z.infer<typeof ApplyInputSchema>;

export const HistoryInputSchema = z
  .object({
    map_id: z.string().min(1).max(512),
    action: z.enum(["undo", "redo"]),
    steps: z.literal(1).default(1),
    expected_content_revision: z.int().nonnegative(),
    idempotency_key: z.uuid(),
  })
  .strict();

export type HistoryInput = z.infer<typeof HistoryInputSchema>;

export const ViewInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("apply_filter"),
    map_id: z.string().min(1).max(512),
    expected_view_revision: z.int().nonnegative(),
    query: z.object({
      mode: z.literal("literal"),
      value: z.string().min(1).max(512),
      case_sensitive: z.boolean().default(false),
    }).strict(),
    show_ancestors: z.boolean().default(true),
    show_descendants: z.boolean().default(false),
  }).strict(),
  z.object({
    action: z.literal("clear_filter"),
    map_id: z.string().min(1).max(512),
    expected_view_revision: z.int().nonnegative(),
  }).strict(),
]);

export type ViewInput = z.infer<typeof ViewInputSchema>;

const AbsoluteLocalPathSchema = z.string().min(1).max(4_096).regex(/^\//);
const FileRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null);
const DocumentWriteFields = {
  overwrite: z.boolean().default(false),
  dry_run: z.boolean().default(true),
  idempotency_key: z.uuid(),
  confirmation: ConfirmationSchema.nullable().default(null),
} as const;

export const DocumentInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("create_from_template"),
    template_path: AbsoluteLocalPathSchema,
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("open"),
    path: AbsoluteLocalPathSchema,
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("save"),
    map_id: z.string().min(1).max(512),
    expected_content_revision: z.int().nonnegative(),
    expected_file_revision: FileRevisionSchema,
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("save_as"),
    map_id: z.string().min(1).max(512),
    path: AbsoluteLocalPathSchema,
    expected_content_revision: z.int().nonnegative(),
    expected_file_revision: FileRevisionSchema,
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("close"),
    map_id: z.string().min(1).max(512),
    close_mode: z.enum(["save_then_close", "discard_then_close", "cancel"]),
    expected_content_revision: z.int().nonnegative(),
    expected_file_revision: FileRevisionSchema,
    ...DocumentWriteFields,
  }).strict(),
  z.object({
    action: z.literal("revert"),
    map_id: z.string().min(1).max(512),
    expected_content_revision: z.int().nonnegative(),
    expected_file_revision: z.string().regex(/^[a-f0-9]{64}$/),
    ...DocumentWriteFields,
  }).strict(),
]);

export type DocumentInput = z.infer<typeof DocumentInputSchema>;

export const ExportInputSchema = z.object({
  map_id: z.string().min(1).max(512),
  scope: z.literal("map").default("map"),
  root_node_id: z.literal(null).default(null),
  format_id: z.enum(["png", "pdf", "svg", "html"]),
  destination: AbsoluteLocalPathSchema,
  expected_content_revision: z.int().nonnegative(),
  overwrite: z.boolean().default(false),
  dry_run: z.boolean().default(true),
  idempotency_key: z.uuid(),
  options: z.object({}).strict().default({}),
  confirmation: ConfirmationSchema.nullable().default(null),
}).strict();

export type ExportInput = z.infer<typeof ExportInputSchema>;

const InvokeActionFields = {
  map_id: z.string().min(1).max(512),
  expected_content_revision: z.int().nonnegative(),
  expected_view_revision: z.int().nonnegative(),
  dry_run: z.boolean().default(true),
  idempotency_key: z.uuid(),
  confirmation: z.literal(null).default(null),
} as const;

export const InvokeActionInputSchema = z.discriminatedUnion("capability_id", [
  z.object({
    capability_id: z.literal("presentation.navigate"),
    action: z.enum(["start", "stop", "first", "previous", "next", "last"]),
    ...InvokeActionFields,
  }).strict(),
  z.object({
    capability_id: z.literal("print.preview"),
    action: z.enum(["open", "close"]),
    ...InvokeActionFields,
  }).strict(),
]);

export type InvokeActionInput = z.infer<typeof InvokeActionInputSchema>;

export const TOOL_NAMES = [
  "freeplane_status",
  "freeplane_capabilities",
  "freeplane_list_maps",
  "freeplane_read",
  "freeplane_search",
  "freeplane_changes",
  "freeplane_apply",
  "freeplane_document",
  "freeplane_view",
  "freeplane_export",
  "freeplane_history",
  "freeplane_invoke_action",
] as const;

export function emptyEvidence(): z.infer<typeof EvidenceSchema> {
  return { readback: null, events: [], artifact: null };
}
