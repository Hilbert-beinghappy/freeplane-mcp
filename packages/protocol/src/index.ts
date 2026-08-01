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
