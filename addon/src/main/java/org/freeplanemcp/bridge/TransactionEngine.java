package org.freeplanemcp.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;

import org.freeplane.api.Connector;
import org.freeplane.api.Controller;
import org.freeplane.api.Node;
import org.freeplane.core.undo.IUndoHandler;
import org.freeplane.features.mode.mindmapmode.MModeController;
import org.freeplane.plugin.script.proxy.AbstractProxy;

import javax.swing.Timer;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.freeplanemcp.bridge.BridgeSupport.BridgeException;
import static org.freeplanemcp.bridge.BridgeSupport.map;

final class TransactionEngine {
    private static final int MAX_OPERATIONS = 500;
    private static final int MAX_PLANS = 100;
    private static final Set<String> OPERATION_TYPES = Set.of(
            "create_child",
            "set_text",
            "set_note",
            "set_attribute",
            "set_tags",
            "add_icon",
            "set_style_background",
            "move_node",
            "set_folded",
            "add_connector",
            "delete_node");

    private final Controller controller;
    private final MapRegistry registry;
    private final boolean qualification;
    private final Map<String, Plan> plans = new LinkedHashMap<>();

    TransactionEngine(Controller controller, MapRegistry registry, boolean qualification) {
        this.controller = controller;
        this.registry = registry;
        this.qualification = qualification;
    }

    Map<String, Object> plan(JsonNode request) {
        MapRegistry.State state = registry.requireState(BridgeSupport.requiredText(request, "map_id"));
        long expectedRevision = BridgeSupport.requiredNonNegativeLong(request, "expected_content_revision");
        registry.reconcile(state, "snapshot.reconciled", List.of("plan_precondition"), List.of());
        if (state.recoveryRequired) {
            throw new BridgeException(409, "RECOVERY_REQUIRED", "Map is locked after a failed rollback verification");
        }
        if (state.contentRevision != expectedRevision) {
            throw revisionConflict(state, expectedRevision);
        }
        ArrayNode operations = BridgeSupport.requiredArray(request, "operations");
        if (operations.isEmpty() || operations.size() > MAX_OPERATIONS) {
            throw new BridgeException(413, "LIMIT_EXCEEDED", "operations must contain between 1 and 500 entries");
        }
        validateOperations(state, operations);
        removeExpiredPlans();
        if (plans.size() >= MAX_PLANS) plans.remove(plans.keySet().iterator().next());

        JsonNode hashInput = BridgeSupport.JSON.valueToTree(map(
                "map_id", state.mapId,
                "expected_content_revision", expectedRevision,
                "operations", operations));
        String hash = BridgeSupport.canonicalHash(hashInput);
        String id = "fpplan:" + UUID.randomUUID();
        Instant expiresAt = Instant.now().plus(2, ChronoUnit.MINUTES);
        plans.put(id, new Plan(state.mapId, expectedRevision, operations.deepCopy(), hash, expiresAt));
        return map(
                "plan_id", id,
                "plan_hash", hash,
                "map_id", state.mapId,
                "content_revision", expectedRevision,
                "operation_count", operations.size(),
                "expires_at", expiresAt.toString(),
                "dry_run", true);
    }

    CompletableFuture<Map<String, Object>> commit(JsonNode request) {
        String planId = BridgeSupport.requiredText(request, "plan_id");
        String suppliedHash = BridgeSupport.requiredText(request, "plan_hash");
        Plan plan = plans.get(planId);
        if (plan == null) throw new BridgeException(404, "CONFIRMATION_EXPIRED", "Transaction plan is unavailable");
        if (Instant.now().isAfter(plan.expiresAt)) {
            plans.remove(planId);
            throw new BridgeException(410, "CONFIRMATION_EXPIRED", "Transaction plan has expired");
        }
        if (!plan.hash.equals(suppliedHash)) {
            throw new BridgeException(409, "CONFIRMATION_STALE", "plan_hash does not match the stored plan");
        }

        MapRegistry.State state = registry.requireState(plan.mapId);
        registry.reconcile(state, "snapshot.reconciled", List.of("commit_precondition"), List.of());
        if (state.recoveryRequired) {
            throw new BridgeException(409, "RECOVERY_REQUIRED", "Map is locked after a failed rollback verification");
        }
        if (state.contentRevision != plan.expectedRevision) {
            throw revisionConflict(state, plan.expectedRevision);
        }
        if (registry.activeState() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "The planned map is not the active Freeplane map");
        }

        Integer failureAfter = null;
        String failureMode = null;
        if (request.has("failure_after_op") || request.has("failure_mode")) {
            if (!qualification) {
                throw new BridgeException(403, "POLICY_DENIED", "Failure injection is available only in an isolated qualification run");
            }
            if (request.has("failure_after_op")) {
                if (!request.path("failure_after_op").isIntegralNumber()
                        || !request.path("failure_after_op").canConvertToInt()) {
                    throw new BridgeException(400, "VALIDATION_ERROR", "failure_after_op must be an integer");
                }
                failureAfter = request.path("failure_after_op").intValue();
                if (failureAfter < 1 || failureAfter > plan.operations.size()) {
                    throw new BridgeException(400, "VALIDATION_ERROR", "failure_after_op is outside the plan");
                }
            }
            failureMode = request.path("failure_mode").isTextual()
                    ? request.path("failure_mode").textValue()
                    : null;
            if (failureMode != null && !failureMode.equals("postcondition")) {
                throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported failure_mode");
            }
        }

        plans.remove(planId);
        String transactionId = "fptx:" + UUID.randomUUID();
        Run run = new Run(state, transactionId, failureAfter, failureMode);
        CompletableFuture<Map<String, Object>> completion = new CompletableFuture<>();
        try {
            registry.withEventContext("mcp", transactionId, () -> {
                execute(plan, run);
                return null;
            });
            run.handler.delayedCommit();
            awaitSettlement(run, completion, "commit", run.deadlineNanos,
                    () -> registry.withEventContext("mcp", transactionId, () -> finishCommit(plan, run)));
        } catch (Throwable failure) {
            beginRollback(run, failure, completion);
        }
        return completion;
    }

    private void execute(Plan plan, Run run) {
        run.before = registry.reconcile(run.state, "snapshot.reconciled", List.of("transaction_before"), List.of());
        run.handler = run.state.model.getExtension(IUndoHandler.class);
        if (run.handler == null || !(run.state.map instanceof AbstractProxy<?> proxy)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Qualified undo internals are unavailable for this map");
        }
        run.mode = proxy.getModeController();
        run.beforeLevel = run.handler.getTransactionLevel();
        if (run.beforeLevel != 0) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Freeplane already has an open undo transaction", map(
                    "transaction_level", run.beforeLevel));
        }

        try {
            run.mode.startTransaction();
        } finally {
            run.started = run.handler.getTransactionLevel() > run.beforeLevel;
        }
        requireLevel(run, run.beforeLevel + 1, "startTransaction");
        Map<String, Node> temporary = new HashMap<>();
        int index = 0;
        for (JsonNode operation : plan.operations) {
            requireBeforeDeadline(run);
            index++;
            apply(run.state, operation, temporary);
            String type = operation.path("type").textValue();
            registry.reconcile(run.state, "transaction.operation", List.of(type), affectedIds(operation, temporary));
            requireLevel(run, run.beforeLevel + 1, "operation " + index);
            requireBeforeDeadline(run);
            if (run.failureAfter != null && run.failureAfter == index) {
                throw new BridgeException(422, "POSTCONDITION_FAILED", "Injected failure after operation " + index);
            }
        }

        MapRegistry.Snapshot uncommitted = registry.reconcile(
                run.state, "transaction.readback", List.of("postcondition"), List.of());
        if (uncommitted.hash().equals(run.before.hash())) {
            throw new BridgeException(422, "POSTCONDITION_FAILED", "Transaction produced no observable content change");
        }
        if ("postcondition".equals(run.failureMode)) {
            throw new BridgeException(422, "POSTCONDITION_FAILED", "Injected postcondition mismatch");
        }
    }

    private Map<String, Object> finishCommit(Plan plan, Run run) {
        run.started = false;
        if (run.handler.getTransactionLevel() != run.beforeLevel) {
            registry.markRecoveryRequired(run.state);
            throw new BridgeException(500, "RECOVERY_REQUIRED", "Transaction level did not recover after commit", map(
                    "before_level", run.beforeLevel,
                    "after_level", run.handler.getTransactionLevel()));
        }
        MapRegistry.Snapshot after = registry.reconcile(
                run.state, "transaction.committed", List.of("commit"), List.of());
        return map(
                "transaction_id", run.transactionId,
                "map_id", run.state.mapId,
                "operation_count", plan.operations.size(),
                "before", map(
                        "content_revision", plan.expectedRevision,
                        "snapshot_sha256", run.before.hash()),
                "after", map(
                        "content_revision", run.state.contentRevision,
                        "snapshot_sha256", after.hash()),
                "transaction_level_before", run.beforeLevel,
                "transaction_level_after", run.handler.getTransactionLevel(),
                "effect_status", "verified");
    }

    private void beginRollback(
            Run run,
            Throwable failure,
            CompletableFuture<Map<String, Object>> completion) {
        if (!run.started || run.handler == null || run.mode == null || run.before == null) {
            completion.completeExceptionally(failure instanceof BridgeException
                    ? failure
                    : new BridgeException(500, "FREEPLANE_ERROR", safeMessage(failure)));
            return;
        }

        try {
            run.handler.delayedRollback();
            awaitSettlement(
                    run,
                    completion,
                    "rollback",
                    System.nanoTime() + TimeUnit.SECONDS.toNanos(5),
                    () -> registry.withEventContext("mcp", run.transactionId,
                            () -> finishRollback(run, failure)));
        } catch (Throwable rollbackFailure) {
            registry.markRecoveryRequired(run.state);
            completion.completeExceptionally(new BridgeException(
                    500,
                    "ROLLBACK_FAILED",
                    "Rollback could not be scheduled",
                    map(
                            "transaction_id", run.transactionId,
                            "cause", safeMessage(rollbackFailure),
                            "recovery_required", true)));
        }
    }

    private Map<String, Object> finishRollback(Run run, Throwable failure) {
        run.started = false;
        MapRegistry.Snapshot actual;
        try {
            actual = registry.reconcile(run.state, "transaction.rolled_back", List.of("rollback"), List.of());
        } catch (Throwable snapshotFailure) {
            registry.markRecoveryRequired(run.state);
            throw new BridgeException(500, "ROLLBACK_FAILED", "Rollback snapshot could not be captured", map(
                    "transaction_id", run.transactionId,
                    "cause", safeMessage(snapshotFailure)));
        }
        boolean levelRestored = run.handler.getTransactionLevel() == run.beforeLevel;
        boolean snapshotEqual = actual.hash().equals(run.before.hash());
        if (!levelRestored || !snapshotEqual) {
            registry.markRecoveryRequired(run.state);
            throw new BridgeException(500, "ROLLBACK_FAILED", "Rollback verification failed", map(
                    "transaction_id", run.transactionId,
                    "transaction_level_restored", levelRestored,
                    "snapshot_equal", snapshotEqual,
                    "expected_snapshot_sha256", run.before.hash(),
                    "actual_snapshot_sha256", actual.hash(),
                    "recovery_required", true));
        }

        String category = failure instanceof BridgeException bridge ? bridge.category : "FREEPLANE_ERROR";
        int status = failure instanceof BridgeException bridge ? bridge.status : 500;
        throw new BridgeException(status, category, safeMessage(failure), map(
                "transaction_id", run.transactionId,
                "rolled_back", true,
                "transaction_level_restored", true,
                "snapshot_equal", true,
                "snapshot_sha256", actual.hash(),
                "recovery_required", false));
    }

    private void awaitSettlement(
            Run run,
            CompletableFuture<Map<String, Object>> completion,
            String phase,
            long deadlineNanos,
            java.util.concurrent.Callable<Map<String, Object>> finish) {
        Timer timer = new Timer(10, null);
        timer.addActionListener(event -> {
            if (completion.isDone()) {
                timer.stop();
                return;
            }
            if (run.handler.getTransactionLevel() == run.beforeLevel) {
                timer.stop();
                try {
                    completion.complete(finish.call());
                } catch (Throwable failure) {
                    if (phase.equals("commit")) {
                        registry.markRecoveryRequired(run.state);
                        completion.completeExceptionally(new BridgeException(
                                500,
                                "RECOVERY_REQUIRED",
                                "Committed transaction could not be verified",
                                map(
                                        "transaction_id", run.transactionId,
                                        "cause", safeMessage(failure),
                                        "recovery_required", true)));
                    } else {
                        completion.completeExceptionally(failure);
                    }
                }
                return;
            }
            if (System.nanoTime() > deadlineNanos) {
                timer.stop();
                registry.markRecoveryRequired(run.state);
                completion.completeExceptionally(new BridgeException(
                        500,
                        phase.equals("rollback") ? "ROLLBACK_FAILED" : "RECOVERY_REQUIRED",
                        "Freeplane " + phase + " did not restore the transaction level",
                        map(
                                "transaction_id", run.transactionId,
                                "before_level", run.beforeLevel,
                                "after_level", run.handler.getTransactionLevel(),
                                "recovery_required", true)));
            }
        });
        timer.setInitialDelay(0);
        timer.start();
    }

    Map<String, Object> qualificationHistory(JsonNode request) {
        if (!qualification) {
            throw new BridgeException(403, "POLICY_DENIED", "History qualification is disabled outside an isolated run");
        }
        MapRegistry.State state = registry.requireState(BridgeSupport.requiredText(request, "map_id"));
        if (registry.activeState() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "History target is not the active map");
        }
        String action = BridgeSupport.requiredText(request, "action");
        if (!action.equals("undo") && !action.equals("redo")) {
            throw new BridgeException(400, "VALIDATION_ERROR", "action must be undo or redo");
        }
        IUndoHandler handler = state.model.getExtension(IUndoHandler.class);
        if (handler == null || handler.getTransactionLevel() != 0) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Undo handler is unavailable or busy");
        }
        if (action.equals("undo") && !handler.canUndo()) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Nothing can be undone");
        }
        if (action.equals("redo") && !handler.canRedo()) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Nothing can be redone");
        }
        MapRegistry.Snapshot before = registry.reconcile(state, "snapshot.reconciled", List.of("history_before"), List.of());
        String description = handler.getLastDescription();
        registry.withEventContext("system", null, () -> {
            if (action.equals("undo")) controller.undo();
            else controller.redo();
            return null;
        });
        MapRegistry.Snapshot after = registry.reconcile(state, "history." + action, List.of(action), List.of());
        return map(
                "map_id", state.mapId,
                "action", action,
                "description", description,
                "before_snapshot_sha256", before.hash(),
                "after_snapshot_sha256", after.hash(),
                "content_revision", state.contentRevision,
                "transaction_level", handler.getTransactionLevel());
    }

    private void apply(MapRegistry.State state, JsonNode operation, Map<String, Node> temporary) {
        String type = operation.path("type").textValue();
        switch (type) {
            case "create_child" -> {
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                String text = operation.path("text").textValue();
                Node child = parent.createChild(text);
                temporary.put(operation.path("temp_id").textValue(), child);
                if (!text.equals(child.getText()) || child.getParent() == null
                        || !child.getParent().getId().equals(parent.getId())) {
                    throw new BridgeException(422, "POSTCONDITION_FAILED", "create_child readback diverged");
                }
            }
            case "set_text" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String value = operation.path("value").textValue();
                node.setText(value);
                require(value.equals(node.getText()), "set_text readback diverged");
            }
            case "set_note" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String value = operation.path("value").textValue();
                node.setNote(value);
                require(node.getNote() != null && value.equals(node.getNote().toString()), "set_note readback diverged");
            }
            case "set_attribute" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String name = operation.path("name").textValue();
                String value = operation.path("value").textValue();
                node.getAttributes().set(name, value);
                require(value.equals(String.valueOf(node.getAttributes().getFirst(name))), "set_attribute readback diverged");
            }
            case "set_tags" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                List<String> values = textArray(operation.path("tags"), "tags");
                node.getTags().setTags(values);
                require(new HashSet<>(values).equals(new HashSet<>(node.getTags().getTags())), "set_tags readback diverged");
            }
            case "add_icon" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String icon = operation.path("icon").textValue();
                node.getIcons().add(icon);
                require(node.getIcons().contains(icon), "add_icon readback diverged");
            }
            case "set_style_background" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String color = operation.path("color").textValue();
                node.getStyle().setBackgroundColorCode(color);
                require(color.equalsIgnoreCase(node.getStyle().getBackgroundColorCode()), "set_style_background readback diverged");
            }
            case "move_node" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                int position = operation.path("position").intValue();
                node.moveTo(parent, Math.min(position, parent.getChildren().size()));
                require(node.getParent() != null
                        && node.getParent().getId().equals(parent.getId())
                        && parent.getChildPosition(node) >= 0, "move_node readback diverged");
            }
            case "set_folded" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                boolean value = operation.path("value").booleanValue();
                node.setFolded(value);
                require(node.isFolded() == value, "set_folded readback diverged");
            }
            case "add_connector" -> {
                Node source = resolve(state, operation.path("source").textValue(), temporary);
                Node target = resolve(state, operation.path("target").textValue(), temporary);
                Connector connector = source.addConnectorTo(target);
                require(connector != null && connector.getTarget().getId().equals(target.getId()), "add_connector readback diverged");
            }
            case "delete_node" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                require(!node.isRoot(), "root node cannot be deleted");
                String id = node.getId();
                node.delete();
                require(registry.findNode(state, id) == null, "delete_node readback diverged");
            }
            default -> throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported operation type: " + type);
        }
    }

    private void validateOperations(MapRegistry.State state, ArrayNode operations) {
        Set<String> temporary = new HashSet<>();
        Set<String> deleted = new HashSet<>();
        for (int index = 0; index < operations.size(); index++) {
            JsonNode operation = operations.get(index);
            if (!operation.isObject()) {
                throw new BridgeException(400, "VALIDATION_ERROR", "operation " + (index + 1) + " must be an object");
            }
            String type = BridgeSupport.requiredText(operation, "type");
            if (!OPERATION_TYPES.contains(type)) {
                throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported operation type: " + type);
            }
            switch (type) {
                case "create_child" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "parent"), temporary, deleted);
                    String temp = BridgeSupport.requiredText(operation, "temp_id");
                    if (!temp.matches("\\$[A-Za-z][A-Za-z0-9_-]{0,63}") || !temporary.add(temp)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "temp_id must be a unique $-prefixed identifier");
                    }
                    text(operation, "text", true);
                }
                case "set_text", "set_note" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    text(operation, "value", true);
                }
                case "set_attribute" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    text(operation, "name", false);
                    text(operation, "value", true);
                }
                case "set_tags" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    List<String> tags = textArray(operation.get("tags"), "tags");
                    if (tags.size() > 100) throw new BridgeException(413, "LIMIT_EXCEEDED", "tags exceeds 100 entries");
                }
                case "add_icon" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    text(operation, "icon", false);
                }
                case "set_style_background" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    if (!BridgeSupport.requiredText(operation, "color").matches("#[0-9A-Fa-f]{6}")) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "color must be #RRGGBB");
                    }
                }
                case "move_node" -> {
                    String node = BridgeSupport.requiredText(operation, "node");
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    validateReference(state, node, temporary, deleted);
                    validateReference(state, parent, temporary, deleted);
                    if (node.equals(parent)) throw new BridgeException(400, "VALIDATION_ERROR", "node cannot be its own parent");
                    if (!operation.path("position").isIntegralNumber()
                            || !operation.path("position").canConvertToInt()
                            || operation.path("position").intValue() < 0) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "position must be a non-negative integer");
                    }
                    if (!node.startsWith("$") && !parent.startsWith("$")) {
                        Node nodeValue = registry.requireNode(state, node);
                        Node parentValue = registry.requireNode(state, parent);
                        if (parentValue.isDescendantOf(nodeValue)) {
                            throw new BridgeException(400, "VALIDATION_ERROR", "move_node would create a cycle");
                        }
                    }
                }
                case "set_folded" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "node"), temporary, deleted);
                    if (!operation.path("value").isBoolean()) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "value must be boolean");
                    }
                }
                case "add_connector" -> {
                    validateReference(state, BridgeSupport.requiredText(operation, "source"), temporary, deleted);
                    validateReference(state, BridgeSupport.requiredText(operation, "target"), temporary, deleted);
                }
                case "delete_node" -> {
                    String node = BridgeSupport.requiredText(operation, "node");
                    validateReference(state, node, temporary, deleted);
                    if (!node.startsWith("$") && registry.requireNode(state, node).isRoot()) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "root node cannot be deleted");
                    }
                    deleted.add(node);
                }
                default -> throw new AssertionError(type);
            }
        }
    }

    private void validateReference(MapRegistry.State state, String reference, Set<String> temporary, Set<String> deleted) {
        if (deleted.contains(reference)) {
            throw new BridgeException(400, "VALIDATION_ERROR", "operation references a node after deleting it: " + reference);
        }
        if (reference.startsWith("$")) {
            if (!temporary.contains(reference)) {
                throw new BridgeException(400, "VALIDATION_ERROR", "unknown temporary node reference: " + reference);
            }
        } else {
            registry.requireNode(state, reference);
        }
    }

    private static String text(JsonNode object, String field, boolean allowEmpty) {
        JsonNode value = object.get(field);
        if (value == null || !value.isTextual() || (!allowEmpty && value.textValue().isBlank())) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a string");
        }
        if (value.textValue().length() > 100_000) {
            throw new BridgeException(413, "LIMIT_EXCEEDED", field + " exceeds 100000 characters");
        }
        return value.textValue();
    }

    private static List<String> textArray(JsonNode value, String field) {
        if (value == null || !value.isArray()) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be an array of strings");
        }
        List<String> result = new ArrayList<>();
        for (JsonNode item : value) {
            if (!item.isTextual() || item.textValue().isBlank()) {
                throw new BridgeException(400, "VALIDATION_ERROR", field + " must contain non-empty strings");
            }
            result.add(item.textValue());
        }
        return result;
    }

    private static Node resolve(MapRegistry.State state, String reference, Map<String, Node> temporary) {
        Node node = reference.startsWith("$") ? temporary.get(reference) : null;
        if (!reference.startsWith("$")) {
            DequeSearch search = new DequeSearch(state.map.getRoot(), reference);
            node = search.find();
        }
        if (node == null) throw new BridgeException(404, "NODE_NOT_FOUND", "Node reference is unavailable: " + reference);
        return node;
    }

    private static List<String> affectedIds(JsonNode operation, Map<String, Node> temporary) {
        List<String> ids = new ArrayList<>();
        for (String field : List.of("node", "parent", "source", "target", "temp_id")) {
            JsonNode value = operation.get(field);
            if (value == null || !value.isTextual()) continue;
            String reference = value.textValue();
            Node temp = temporary.get(reference);
            ids.add(temp == null ? reference : temp.getId());
        }
        return ids;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new BridgeException(422, "POSTCONDITION_FAILED", message);
    }

    private static void requireLevel(Run run, int expected, String phase) {
        int actual = run.handler.getTransactionLevel();
        if (actual != expected) {
            throw new BridgeException(500, "RECOVERY_REQUIRED", "Unexpected transaction level after " + phase, map(
                    "expected", expected,
                    "actual", actual));
        }
    }

    private static void requireBeforeDeadline(Run run) {
        if (System.nanoTime() > run.deadlineNanos) {
            throw new BridgeException(504, "TIMEOUT", "Transaction exceeded its 10 second execution deadline");
        }
    }

    private static BridgeException revisionConflict(MapRegistry.State state, long expected) {
        return new BridgeException(409, "REVISION_CONFLICT", "Map content revision changed", map(
                "expected_content_revision", expected,
                "actual_content_revision", state.contentRevision));
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private void removeExpiredPlans() {
        Instant now = Instant.now();
        plans.values().removeIf(plan -> now.isAfter(plan.expiresAt));
    }

    private record Plan(
            String mapId,
            long expectedRevision,
            ArrayNode operations,
            String hash,
            Instant expiresAt) {
    }

    private static final class Run {
        final MapRegistry.State state;
        final String transactionId;
        final Integer failureAfter;
        final String failureMode;
        final long deadlineNanos = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
        MapRegistry.Snapshot before;
        IUndoHandler handler;
        MModeController mode;
        int beforeLevel;
        boolean started;

        Run(MapRegistry.State state, String transactionId, Integer failureAfter, String failureMode) {
            this.state = state;
            this.transactionId = transactionId;
            this.failureAfter = failureAfter;
            this.failureMode = failureMode;
        }
    }

    private static final class DequeSearch {
        private final Node root;
        private final String id;

        DequeSearch(Node root, String id) {
            this.root = root;
            this.id = id;
        }

        Node find() {
            java.util.ArrayDeque<Node> queue = new java.util.ArrayDeque<>();
            queue.add(root);
            int count = 0;
            while (!queue.isEmpty()) {
                Node node = queue.removeFirst();
                if (++count > MapRegistry.MAX_NODES) {
                    throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
                }
                if (id.equals(node.getId())) return node;
                queue.addAll(node.getChildren());
            }
            return null;
        }
    }
}
