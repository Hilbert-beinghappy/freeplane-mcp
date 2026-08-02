package org.freeplanemcp.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;

import org.freeplane.api.Connector;
import org.freeplane.api.ChildNodesLayout;
import org.freeplane.api.Controller;
import org.freeplane.api.Node;
import org.freeplane.api.NodeShape;
import org.freeplane.api.Side;
import org.freeplane.core.undo.IActor;
import org.freeplane.core.undo.IUndoHandler;
import org.freeplane.features.bookmarks.mindmapmode.BookmarksController;
import org.freeplane.features.bookmarks.mindmapmode.NodeBookmarkDescriptor;
import org.freeplane.features.map.AlwaysUnfoldedNode;
import org.freeplane.features.map.FirstGroupNode;
import org.freeplane.features.map.FirstGroupNodeFlag;
import org.freeplane.features.map.NodeModel;
import org.freeplane.features.map.SummaryLevels;
import org.freeplane.features.map.SummaryNode;
import org.freeplane.features.map.SummaryNodeFlag;
import org.freeplane.features.map.mindmapmode.MMapController;
import org.freeplane.features.mode.mindmapmode.MModeController;
import org.freeplane.plugin.script.proxy.AbstractProxy;

import javax.swing.Timer;
import javax.swing.SwingUtilities;
import java.net.URI;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.ArrayDeque;
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
            "set_details",
            "set_note",
            "set_attribute",
            "set_attributes",
            "set_tags",
            "add_icon",
            "set_icons",
            "set_link",
            "move_node",
            "reorder_children",
            "set_folded",
            "add_connector",
            "update_connector",
            "remove_connector",
            "delete_node",
            "clone_node",
            "create_summary",
            "set_free",
            "set_side",
            "set_style",
            "set_layout",
            "set_cloud",
            "set_bookmark",
            "set_formula",
            "set_reminder");

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
        Long expectedViewRevision = optionalRevision(request, "expected_view_revision");
        registry.reconcile(state, "snapshot.reconciled", List.of("plan_precondition"), List.of());
        if (state.recoveryRequired) {
            throw new BridgeException(409, "RECOVERY_REQUIRED", "Map is locked after a failed rollback verification");
        }
        if (state.contentRevision != expectedRevision) {
            throw revisionConflict(state, expectedRevision);
        }
        if (expectedViewRevision != null && state.viewRevision != expectedViewRevision) {
            throw viewRevisionConflict(state, expectedViewRevision);
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
                "expected_view_revision", expectedViewRevision,
                "operations", operations));
        String hash = BridgeSupport.canonicalHash(hashInput);
        String id = "fpplan:" + UUID.randomUUID();
        Instant expiresAt = Instant.now().plus(5, ChronoUnit.MINUTES);
        plans.put(id, new Plan(state.mapId, expectedRevision, expectedViewRevision, operations.deepCopy(), hash, expiresAt));
        return map(
                "plan_id", id,
                "plan_hash", hash,
                "map_id", state.mapId,
                "content_revision", expectedRevision,
                "view_revision", state.viewRevision,
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
        if (plan.expectedViewRevision != null && state.viewRevision != plan.expectedViewRevision) {
            throw viewRevisionConflict(state, plan.expectedViewRevision);
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
            scheduleAfterEdtTurns(2, () -> {
                try {
                    scheduleAfterEdtTurns(2, run.handler::commit, failure -> {
                        registry.markRecoveryRequired(run.state);
                        completion.completeExceptionally(new BridgeException(
                                500,
                                "RECOVERY_REQUIRED",
                                "Freeplane commit failed during deferred settlement",
                                map("transaction_id", run.transactionId, "cause", safeMessage(failure))));
                    });
                } catch (Throwable failure) {
                    beginRollback(run, failure, completion);
                }
            }, failure -> beginRollback(run, failure, completion));
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
        int index = 0;
        for (JsonNode operation : plan.operations) {
            requireBeforeDeadline(run);
            index++;
            apply(run.state, operation, run.temporary);
            String type = operation.path("type").textValue();
            registry.reconcile(run.state, "transaction.operation", List.of(type), affectedIds(operation, run.temporary));
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
                "temporary_node_ids", run.temporary.entrySet().stream().collect(
                        java.util.stream.Collectors.toMap(
                                Map.Entry::getKey,
                                entry -> entry.getValue().getId(),
                                (left, right) -> left,
                                LinkedHashMap::new)),
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
            scheduleAfterEdtTurns(2, run.handler::rollback, rollbackFailure -> {
                registry.markRecoveryRequired(run.state);
                completion.completeExceptionally(new BridgeException(
                        500,
                        "ROLLBACK_FAILED",
                        "Rollback failed during deferred settlement",
                        map(
                                "transaction_id", run.transactionId,
                                "cause", safeMessage(rollbackFailure),
                                "stack", qualification ? stackSummary(rollbackFailure) : List.of(),
                                "recovery_required", true)));
            });
            awaitSettlement(
                    run,
                    completion,
                    "rollback",
                    System.nanoTime() + TimeUnit.SECONDS.toNanos(10),
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
                Runnable completeFinish = () -> {
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
                };
                if (phase.equals("rollback")) {
                    scheduleAfterDelayAndEdtTurns(100, 2, completeFinish, failure -> {
                        registry.markRecoveryRequired(run.state);
                        completion.completeExceptionally(new BridgeException(
                                500, "ROLLBACK_FAILED", "Rollback finalization failed", map(
                                        "transaction_id", run.transactionId,
                                        "cause", safeMessage(failure),
                                        "recovery_required", true)));
                    });
                } else {
                    completeFinish.run();
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

    private static void scheduleAfterEdtTurns(
            int turns,
            Runnable action,
            java.util.function.Consumer<Throwable> onFailure) {
        if (turns > 0) {
            SwingUtilities.invokeLater(() -> scheduleAfterEdtTurns(turns - 1, action, onFailure));
            return;
        }
        try {
            action.run();
        } catch (Throwable failure) {
            onFailure.accept(failure);
        }
    }

    private static void scheduleAfterDelayAndEdtTurns(
            int delayMillis,
            int turns,
            Runnable action,
            java.util.function.Consumer<Throwable> onFailure) {
        Timer timer = new Timer(delayMillis, null);
        timer.setRepeats(false);
        timer.addActionListener(event -> scheduleAfterEdtTurns(turns, action, onFailure));
        timer.start();
    }

    CompletableFuture<Map<String, Object>> history(JsonNode request) {
        HistoryRun run = startHistory(request, true);
        CompletableFuture<Map<String, Object>> completion = new CompletableFuture<>();
        Timer timer = new Timer(20, null);
        timer.addActionListener(event -> {
            if (completion.isDone()) {
                timer.stop();
                return;
            }
            try {
                MapRegistry.Snapshot snapshot = registry.reconcile(
                        run.state, "history." + run.action, List.of(run.action), List.of());
                if (run.handler.getTransactionLevel() == 0 && snapshot.hash().equals(run.lastHash)) {
                    run.stableSamples++;
                } else {
                    run.stableSamples = 0;
                    run.lastHash = snapshot.hash();
                }
                if (run.stableSamples >= 3
                        && System.nanoTime() - run.startedNanos >= TimeUnit.MILLISECONDS.toNanos(200)) {
                    if (snapshot.hash().equals(run.before.hash())
                            && run.volatileActionsSkipped < 8
                            && canContinueHistory(run)) {
                        run.volatileActionsSkipped++;
                        run.stableSamples = 0;
                        run.lastHash = null;
                        performHistoryAction(run.state, run.handler, run.action);
                        return;
                    }
                    timer.stop();
                    completion.complete(historyResult(run, snapshot));
                    return;
                }
                if (System.nanoTime() > run.deadlineNanos) {
                    timer.stop();
                    registry.markRecoveryRequired(run.state);
                    completion.completeExceptionally(new BridgeException(
                            500,
                            "RECOVERY_REQUIRED",
                            "Freeplane history action did not settle to a stable snapshot",
                            map("action", run.action, "recovery_required", true)));
                }
            } catch (Throwable failure) {
                timer.stop();
                registry.markRecoveryRequired(run.state);
                completion.completeExceptionally(new BridgeException(
                        500,
                        "RECOVERY_REQUIRED",
                        "Freeplane history readback failed",
                        map("action", run.action, "cause", safeMessage(failure), "recovery_required", true)));
            }
        });
        timer.setInitialDelay(0);
        timer.start();
        return completion;
    }

    Map<String, Object> qualificationHistory(JsonNode request) {
        if (!qualification) throw new BridgeException(403, "POLICY_DENIED", "History qualification is disabled outside an isolated run");
        HistoryRun run = startHistory(request, false);
        MapRegistry.Snapshot after = registry.reconcile(run.state, "history." + run.action, List.of(run.action), List.of());
        return historyResult(run, after);
    }

    private HistoryRun startHistory(JsonNode request, boolean requireRevision) {
        MapRegistry.State state = registry.requireState(BridgeSupport.requiredText(request, "map_id"));
        if (registry.activeState() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "History target is not the active map");
        }
        String action = BridgeSupport.requiredText(request, "action");
        if (!action.equals("undo") && !action.equals("redo")) {
            throw new BridgeException(400, "VALIDATION_ERROR", "action must be undo or redo");
        }
        if (requireRevision) {
            long expectedRevision = BridgeSupport.requiredNonNegativeLong(request, "expected_content_revision");
            registry.reconcile(state, "snapshot.reconciled", List.of("history_precondition"), List.of());
            if (state.recoveryRequired) {
                throw new BridgeException(409, "RECOVERY_REQUIRED", "Map is locked after a failed rollback verification");
            }
            if (state.contentRevision != expectedRevision) throw revisionConflict(state, expectedRevision);
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
        String description = "Freeplane action (description unavailable)";
        try {
            description = handler.getLastDescription();
            if (description == null || description.isBlank()) description = "Freeplane action (description unavailable)";
        } catch (RuntimeException unavailable) {
            // Freeplane 1.13.3 can build a compound description from a null child description.
            // Description failure is not a write precondition; canonical history readback remains authoritative.
        }
        HistoryRun run = new HistoryRun(state, handler, action, description, before);
        performHistoryAction(state, handler, action);
        return run;
    }

    private boolean canContinueHistory(HistoryRun run) {
        return run.action.equals("undo") ? run.handler.canUndo() : run.handler.canRedo();
    }

    private void performHistoryAction(MapRegistry.State state, IUndoHandler handler, String action) {
        if (handler.getTransactionLevel() != 0) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Undo handler became busy");
        }
        try {
            registry.withEventContext("system", null, () -> {
                if (action.equals("undo")) controller.undo();
                else controller.redo();
                return null;
            });
        } catch (Throwable failure) {
            throw new BridgeException(500, "FREEPLANE_ERROR", safeMessage(failure), map(
                    "action", action,
                    "stack", qualification ? stackSummary(failure) : List.of()));
        }
    }

    private static Map<String, Object> historyResult(HistoryRun run, MapRegistry.Snapshot after) {
        return map(
                "map_id", run.state.mapId,
                "action", run.action,
                "description", run.description,
                "before_snapshot_sha256", run.before.hash(),
                "after_snapshot_sha256", after.hash(),
                "content_revision", run.state.contentRevision,
                "transaction_level", run.handler.getTransactionLevel());
    }

    private void apply(MapRegistry.State state, JsonNode operation, Map<String, Node> temporary) {
        String type = operation.path("type").textValue();
        switch (type) {
            case "create_child" -> {
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                String text = operation.path("text").textValue();
                int position = operation.has("position")
                        ? operation.path("position").intValue()
                        : parent.getChildren().size();
                Node child = parent.createChild(position);
                child.setText(text);
                temporary.put(operation.path("temp_id").textValue(), child);
                if (!text.equals(child.getText()) || child.getParent() == null
                        || !child.getParent().getId().equals(parent.getId())
                        || parent.getChildPosition(child) != position) {
                    throw new BridgeException(422, "POSTCONDITION_FAILED", "create_child readback diverged");
                }
            }
            case "set_text" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String value = operation.path("value").textValue();
                node.setText(value);
                require(value.equals(node.getText()), "set_text readback diverged");
            }
            case "set_details" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String value = operation.path("value").textValue();
                node.setDetails(value);
                var actual = node.getDetails();
                require(richTextEquals(value, actual == null ? null : actual.getPlain()), "set_details readback diverged");
            }
            case "set_note" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String value = operation.path("value").textValue();
                node.setNote(value);
                var actual = node.getNote();
                require(richTextEquals(value, actual == null ? null : actual.getPlain()), "set_note readback diverged");
            }
            case "set_attribute" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String name = operation.path("name").textValue();
                String value = operation.path("value").textValue();
                node.getAttributes().set(name, value);
                require(value.equals(String.valueOf(node.getAttributes().getFirst(name))), "set_attribute readback diverged");
            }
            case "set_attributes" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                ArrayNode values = (ArrayNode) operation.path("attributes");
                node.getAttributes().clear();
                for (JsonNode value : values) {
                    node.getAttributes().add(value.path("name").textValue(), value.path("value").textValue());
                }
                require(attributesEqual(node, values), "set_attributes readback diverged");
            }
            case "set_tags" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                List<String> values = textArray(operation.path("tags"), "tags");
                node.getTags().setTags(values);
                require(values.equals(node.getTags().getTags()), "set_tags readback diverged");
            }
            case "add_icon" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String icon = operation.path("icon").textValue();
                node.getIcons().add(icon);
                require(node.getIcons().contains(icon), "add_icon readback diverged");
            }
            case "set_icons" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                List<String> values = textArray(operation.path("icons"), "icons");
                node.getIcons().clear();
                node.getIcons().addAll(values);
                require(values.equals(node.getIcons().getIcons()), "set_icons readback diverged");
            }
            case "set_link" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String kind = operation.path("kind").textValue();
                switch (kind) {
                    case "none" -> node.getLink().remove();
                    case "uri" -> node.getLink().setUri(URI.create(operation.path("uri").textValue()));
                    case "node" -> node.getLink().setNode(resolve(state, operation.path("target").textValue(), temporary));
                    case "text" -> node.getLink().setText(operation.path("value").textValue());
                    default -> throw new AssertionError(kind);
                }
                require(linkEqual(state, node, operation, temporary), "set_link readback diverged");
            }
            case "move_node" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                int position = operation.path("position").intValue();
                node.moveTo(parent, position);
                require(node.getParent() != null
                        && node.getParent().getId().equals(parent.getId())
                        && parent.getChildPosition(node) == position, "move_node readback diverged");
            }
            case "reorder_children" -> {
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                List<String> order = textArray(operation.path("children"), "children");
                List<Node> orderedNodes = order.stream().map(reference -> resolve(state, reference, temporary)).toList();
                controller.moveNodes(orderedNodes, parent, 0);
                List<String> expectedOrder = orderedNodes.stream().map(Node::getId).toList();
                List<String> actualOrder = parent.getChildren().stream().map(Node::getId).toList();
                require(expectedOrder.equals(actualOrder), "reorder_children readback diverged");
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
                applyConnectorProperties(connector, operation.path("properties"));
                require(connector != null && connector.getTarget().getId().equals(target.getId())
                        && connectorPropertiesEqual(connector, operation.path("properties"))
                        && findConnectors(state, BridgeSupport.connectorId(source, connector)).size() == 1,
                        "add_connector readback diverged");
            }
            case "update_connector" -> {
                ConnectorRef reference = requireConnector(state, operation.path("connector_id").textValue());
                applyConnectorProperties(reference.connector, operation.path("properties"));
                require(connectorPropertiesEqual(reference.connector, operation.path("properties")),
                        "update_connector readback diverged");
            }
            case "remove_connector" -> {
                ConnectorRef reference = requireConnector(state, operation.path("connector_id").textValue());
                reference.source.removeConnector(reference.connector);
                require(findConnectors(state, operation.path("connector_id").textValue()).isEmpty(),
                        "remove_connector readback diverged");
            }
            case "clone_node" -> {
                Node source = resolve(state, operation.path("source").textValue(), temporary);
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                int position = operation.path("position").intValue();
                Node clone = parent.appendAsCloneWithoutSubtree(source);
                if (parent.getChildPosition(clone) != position) clone.moveTo(parent, position);
                temporary.put(operation.path("temp_id").textValue(), clone);
                require(parent.getChildPosition(clone) == position
                        && clone.getParent() != null
                        && clone.getParent().getId().equals(parent.getId())
                        && clone.getCountNodesSharingContent() >= 1
                        && clone.getNodesSharingContent().stream().anyMatch(node -> node.getId().equals(source.getId())),
                        "clone_node readback diverged");
            }
            case "create_summary" -> {
                Node parent = resolve(state, operation.path("parent").textValue(), temporary);
                Node first = resolve(state, operation.path("first_child").textValue(), temporary);
                Node last = resolve(state, operation.path("last_child").textValue(), temporary);
                Node summary = createSummary(state, parent, first, last, operation.path("text").textValue());
                temporary.put(operation.path("temp_id").textValue(), summary);
                NodeModel summaryModel = modelOf(summary);
                require(summary.getParent() != null
                        && SummaryNode.isSummaryNode(modelOf(summary.getParent()))
                        && summaryModel.getParentNode() != null,
                        "create_summary readback diverged");
            }
            case "set_free" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                boolean value = operation.path("value").booleanValue();
                node.setFree(value);
                require(node.isFree() == value, "set_free readback diverged");
            }
            case "set_side" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                Side side = operation.path("side").textValue().equals("LEFT")
                        ? Side.TOP_OR_LEFT
                        : Side.BOTTOM_OR_RIGHT;
                node.setSideAtRoot(side);
                require(node.getSideAtRoot() == side, "set_side readback diverged");
            }
            case "set_style" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                JsonNode style = operation.path("style");
                if (style.has("background_color")) node.getStyle().setBackgroundColorCode(style.path("background_color").textValue());
                if (style.has("text_color")) node.getStyle().setTextColorCode(style.path("text_color").textValue());
                if (style.has("bold")) node.getStyle().getFont().setBold(style.path("bold").booleanValue());
                if (style.has("italic")) node.getStyle().getFont().setItalic(style.path("italic").booleanValue());
                if (style.has("font_size")) node.getStyle().getFont().setSize(style.path("font_size").intValue());
                if (style.has("node_shape")) node.getGeometry().setShape(NodeShape.valueOf(style.path("node_shape").textValue()));
                require(styleEqual(node, style), "set_style readback diverged");
            }
            case "set_layout" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                JsonNode layout = operation.path("layout");
                if (layout.has("child_nodes")) node.setChildNodesLayout(ChildNodesLayout.valueOf(layout.path("child_nodes").textValue()));
                if (layout.has("horizontal_shift")) node.setHorizontalShift(layout.path("horizontal_shift").intValue());
                if (layout.has("vertical_shift")) node.setVerticalShift(layout.path("vertical_shift").intValue());
                if (layout.has("minimal_distance_between_children")) {
                    node.setMinimalDistanceBetweenChildren(layout.path("minimal_distance_between_children").intValue());
                }
                if (layout.has("base_distance_to_children")) {
                    node.setBaseDistanceToChildren(layout.path("base_distance_to_children").intValue());
                }
                require(layoutEqual(node, layout), "set_layout readback diverged");
            }
            case "set_cloud" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                var cloud = node.getCloud();
                if (operation.has("shape")) cloud.setShape(operation.path("shape").textValue());
                if (operation.has("color")) cloud.setColorCode(operation.path("color").textValue());
                cloud.setEnabled(operation.path("enabled").booleanValue());
                require(cloud.getEnabled() == operation.path("enabled").booleanValue()
                        && (!operation.has("shape") || operation.path("shape").textValue().equals(cloud.getShape()))
                        && (!operation.has("color") || operation.path("color").textValue().equalsIgnoreCase(cloud.getColorCode())),
                        "set_cloud readback diverged");
            }
            case "set_bookmark" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String action = operation.path("action").textValue();
                setBookmarkTransactional(state, node, operation);
                var bookmark = node.getBookmark();
                require(action.equals("remove")
                                ? bookmark == null
                                : bookmark != null
                                    && operation.path("name").textValue().equals(bookmark.getName())
                                    && operation.path("bookmark_type").textValue().equals(bookmark.getType().name()),
                        "set_bookmark readback diverged");
            }
            case "set_formula" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String expression = operation.path("expression").textValue();
                node.setText(expression);
                require(expression.equals(node.getText()), "set_formula readback diverged");
            }
            case "set_reminder" -> {
                Node node = resolve(state, operation.path("node").textValue(), temporary);
                String action = operation.path("action").textValue();
                if (action.equals("remove")) {
                    node.getReminder().remove();
                    require(node.getReminder().getRemindAt() == null, "set_reminder remove readback diverged");
                } else {
                    Instant at = Instant.parse(operation.path("at").textValue());
                    String unit = operation.path("period_unit").textValue();
                    int period = operation.path("period").intValue();
                    node.getReminder().createOrReplace(java.util.Date.from(at), unit, period);
                    require(node.getReminder().getRemindAt() != null
                                    && node.getReminder().getRemindAt().toInstant().equals(at)
                                    && unit.equals(node.getReminder().getPeriodUnit())
                                    && Integer.valueOf(period).equals(node.getReminder().getPeriod())
                                    && (node.getReminder().getScript() == null || node.getReminder().getScript().isBlank()),
                            "set_reminder readback diverged");
                }
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

    private static void setBookmarkTransactional(MapRegistry.State state, Node node, JsonNode operation) {
        if (!(node instanceof AbstractProxy<?> proxy)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Qualified bookmark internals are unavailable");
        }
        MModeController mode = proxy.getModeController();
        BookmarksController bookmarks = mode.getExtension(BookmarksController.class);
        NodeModel model = modelOf(node);
        if (bookmarks == null) throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Bookmark controller is unavailable");
        var mapBookmarks = bookmarks.getBookmarks(state.model);
        var previous = mapBookmarks.getBookmark(model.getID());
        NodeBookmarkDescriptor previousDescriptor = previous == null ? null : previous.getDescriptor();
        int previousPosition = previous == null ? -1 : bookmarks.findBookmarkPosition(mapBookmarks.getBookmarks(), previous);
        if (previous != null && previousPosition < 0) {
            throw new BridgeException(500, "FREEPLANE_ERROR", "Existing bookmark position is inconsistent");
        }
        NodeBookmarkDescriptor desired = operation.path("action").textValue().equals("remove")
                ? null
                : new NodeBookmarkDescriptor(
                        operation.path("name").textValue(),
                        operation.path("bookmark_type").textValue().equals("ROOT"));
        mode.execute(new IActor() {
            @Override
            public void act() {
                bookmarks.removeBookmark(model);
                if (desired != null) bookmarks.addBookmark(model, desired);
            }

            @Override
            public String getDescription() {
                return "set bookmark";
            }

            @Override
            public void undo() {
                bookmarks.removeBookmark(model);
                if (previousDescriptor != null) {
                    bookmarks.addBookmark(model, previousDescriptor);
                    bookmarks.moveBookmark(model, previousPosition);
                }
            }
        }, state.model);
    }

    private Node createSummary(MapRegistry.State state, Node parent, Node first, Node last, String text) {
        NodeModel rootModel = modelOf(state.map.getRoot());
        NodeModel parentModel = modelOf(parent);
        NodeModel firstModel = modelOf(first);
        NodeModel lastModel = modelOf(last);
        int firstIndex = parentModel.getIndex(firstModel);
        int lastIndex = parentModel.getIndex(lastModel);
        boolean topOrLeft = first.isTopOrLeft();
        SummaryLevels levels = new SummaryLevels(rootModel, parentModel);
        require(firstIndex >= 0 && lastIndex >= firstIndex && levels.canInsertSummaryNode(firstIndex, lastIndex, topOrLeft),
                "summary range is not valid in the current native layout");

        if (!(parent instanceof AbstractProxy<?> proxy)
                || !(proxy.getModeController().getMapController() instanceof MMapController mapController)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Native summary controller is unavailable");
        }
        MModeController mode = proxy.getModeController();
        SummaryNode summaryHook = mode.getExtension(SummaryNode.class);
        AlwaysUnfoldedNode unfoldedHook = mode.getExtension(AlwaysUnfoldedNode.class);
        FirstGroupNode firstGroupHook = mode.getExtension(FirstGroupNode.class);
        if (summaryHook == null || unfoldedHook == null || firstGroupHook == null) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Native summary hooks are unavailable");
        }

        NodeModel summaryGroup = mapController.addNewNode(parentModel, lastIndex + 1, lastModel.getSide());
        if (summaryGroup == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Native summary group was not created");
        summaryHook.undoableActivateHook(summaryGroup, SummaryNodeFlag.SUMMARY);
        unfoldedHook.undoableActivateHook(summaryGroup, unfoldedHook);
        if (SummaryNode.isSummaryNode(firstModel)) {
            firstGroupHook.undoableActivateHook(firstModel, FirstGroupNodeFlag.FIRST_GROUP);
        } else {
            NodeModel firstGroup = mapController.addNewNode(parentModel, firstIndex, node -> {
                node.setSide(summaryGroup.getSide());
                node.addExtension(FirstGroupNodeFlag.FIRST_GROUP);
            });
            if (firstGroup == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Native first-group marker was not created");
        }
        NodeModel summaryContent = mapController.addNewNode(summaryGroup, 0, NodeModel.Side.DEFAULT);
        if (summaryContent == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Native summary content was not created");
        Node summary = registry.findNode(state, summaryContent.getID());
        if (summary == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Native summary content proxy is unavailable");
        summary.setText(text);
        require(text.equals(summary.getText())
                        && SummaryNode.isSummaryNode(summaryGroup)
                        && AlwaysUnfoldedNode.isAlwaysUnfolded(summaryGroup),
                "native summary readback diverged");
        return summary;
    }

    private static NodeModel modelOf(Node node) {
        if (!(node instanceof AbstractProxy<?> proxy) || !(proxy.getDelegate() instanceof NodeModel model)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Qualified node internals are unavailable");
        }
        return model;
    }

    private static boolean styleEqual(Node node, JsonNode style) {
        var value = node.getStyle();
        return (!style.has("background_color") || style.path("background_color").textValue().equalsIgnoreCase(value.getBackgroundColorCode()))
                && (!style.has("text_color") || style.path("text_color").textValue().equalsIgnoreCase(value.getTextColorCode()))
                && (!style.has("bold") || style.path("bold").booleanValue() == value.getFont().isBold())
                && (!style.has("italic") || style.path("italic").booleanValue() == value.getFont().isItalic())
                && (!style.has("font_size") || style.path("font_size").intValue() == value.getFont().getSize())
                && (!style.has("node_shape") || style.path("node_shape").textValue().equals(node.getGeometry().getShape().name()));
    }

    private static boolean layoutEqual(Node node, JsonNode layout) {
        return (!layout.has("child_nodes") || layout.path("child_nodes").textValue().equals(node.getChildNodesLayout().name()))
                && (!layout.has("horizontal_shift") || layout.path("horizontal_shift").intValue() == node.getHorizontalShift())
                && (!layout.has("vertical_shift") || layout.path("vertical_shift").intValue() == node.getVerticalShift())
                && (!layout.has("minimal_distance_between_children")
                    || layout.path("minimal_distance_between_children").intValue() == node.getMinimalDistanceBetweenChildren())
                && (!layout.has("base_distance_to_children")
                    || layout.path("base_distance_to_children").intValue() == node.getBaseDistanceToChildrenAsLength().toBaseUnitsRounded());
    }

    private void validateOperations(MapRegistry.State state, ArrayNode operations) {
        ValidationTree tree = new ValidationTree(state);
        Set<String> mutatedConnectors = new HashSet<>();
        Set<String> temporaryIds = new HashSet<>();
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
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    tree.require(parent);
                    String temp = BridgeSupport.requiredText(operation, "temp_id");
                    if (!validTemporaryId(temp) || !temporaryIds.add(temp) || tree.contains(temp)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "temp_id must be a unique $-prefixed identifier");
                    }
                    text(operation, "text", true);
                    int position = operation.has("position")
                            ? requiredPosition(operation, "position")
                            : tree.children(parent).size();
                    tree.create(temp, parent, position);
                }
                case "set_text", "set_details", "set_note" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    text(operation, "value", true);
                }
                case "set_attribute" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    text(operation, "name", false);
                    text(operation, "value", true);
                }
                case "set_attributes" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    ArrayNode attributes = BridgeSupport.requiredArray(operation, "attributes");
                    if (attributes.size() > 1_000) throw new BridgeException(413, "LIMIT_EXCEEDED", "attributes exceeds 1000 entries");
                    for (JsonNode attribute : attributes) {
                        if (!attribute.isObject()) throw new BridgeException(400, "VALIDATION_ERROR", "attributes must contain objects");
                        text(attribute, "name", false);
                        text(attribute, "value", true);
                    }
                }
                case "set_tags" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    List<String> tags = textArray(operation.get("tags"), "tags");
                    if (tags.size() > 100) throw new BridgeException(413, "LIMIT_EXCEEDED", "tags exceeds 100 entries");
                }
                case "add_icon" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    text(operation, "icon", false);
                }
                case "set_icons" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    List<String> icons = textArray(operation.get("icons"), "icons");
                    if (icons.size() > 100) throw new BridgeException(413, "LIMIT_EXCEEDED", "icons exceeds 100 entries");
                }
                case "set_link" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    String kind = BridgeSupport.requiredText(operation, "kind");
                    switch (kind) {
                        case "none" -> { }
                        case "uri" -> {
                            try { URI.create(BridgeSupport.requiredText(operation, "uri")); }
                            catch (IllegalArgumentException invalid) { throw new BridgeException(400, "VALIDATION_ERROR", "uri is invalid"); }
                        }
                        case "node" -> tree.require(BridgeSupport.requiredText(operation, "target"));
                        case "text" -> text(operation, "value", false);
                        default -> throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported link kind: " + kind);
                    }
                }
                case "move_node" -> {
                    String node = BridgeSupport.requiredText(operation, "node");
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    tree.move(node, parent, requiredPosition(operation, "position"));
                }
                case "reorder_children" -> {
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    List<String> children = textArray(operation.get("children"), "children");
                    tree.reorder(parent, children);
                }
                case "set_folded" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    if (!operation.path("value").isBoolean()) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "value must be boolean");
                    }
                }
                case "add_connector" -> {
                    tree.require(BridgeSupport.requiredText(operation, "source"));
                    tree.require(BridgeSupport.requiredText(operation, "target"));
                    validateConnectorProperties(operation.path("properties"), false);
                }
                case "update_connector" -> {
                    String connectorId = BridgeSupport.requiredText(operation, "connector_id");
                    requireConnector(state, connectorId);
                    if (!mutatedConnectors.add(connectorId)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "connector can be changed only once per transaction");
                    }
                    validateConnectorProperties(operation.path("properties"), true);
                }
                case "remove_connector" -> {
                    String connectorId = BridgeSupport.requiredText(operation, "connector_id");
                    requireConnector(state, connectorId);
                    if (!mutatedConnectors.add(connectorId)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "connector can be changed only once per transaction");
                    }
                }
                case "clone_node" -> {
                    String source = BridgeSupport.requiredText(operation, "source");
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    tree.require(source);
                    tree.require(parent);
                    if (source.equals(parent) || tree.isRoot(source)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "clone source must be a non-root node distinct from its parent");
                    }
                    if (!operation.path("with_subtree").isBoolean() || operation.path("with_subtree").booleanValue()) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "only content clones without subtrees are qualified");
                    }
                    String temp = BridgeSupport.requiredText(operation, "temp_id");
                    if (!validTemporaryId(temp) || !temporaryIds.add(temp) || tree.contains(temp)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "temp_id must be a unique $-prefixed identifier");
                    }
                    tree.create(temp, parent, requiredPosition(operation, "position"));
                }
                case "create_summary" -> {
                    String parent = BridgeSupport.requiredText(operation, "parent");
                    String first = BridgeSupport.requiredText(operation, "first_child");
                    String last = BridgeSupport.requiredText(operation, "last_child");
                    String temp = BridgeSupport.requiredText(operation, "temp_id");
                    if (!validTemporaryId(temp) || !temporaryIds.add(temp) || tree.contains(temp)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "temp_id must be a unique $-prefixed identifier");
                    }
                    if (first.startsWith("$") || last.startsWith("$")) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "summary boundaries must be existing native siblings");
                    }
                    tree.requireSummaryRange(parent, first, last);
                    Node parentNode = registry.findNode(state, parent);
                    Node firstNode = registry.findNode(state, first);
                    Node lastNode = registry.findNode(state, last);
                    if (parentNode == null || firstNode == null || lastNode == null
                            || firstNode.getParent() == null || lastNode.getParent() == null
                            || !parentNode.getId().equals(firstNode.getParent().getId())
                            || !parentNode.getId().equals(lastNode.getParent().getId())) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "summary boundaries must be current direct siblings");
                    }
                    int firstIndex = parentNode.getChildPosition(firstNode);
                    int lastIndex = parentNode.getChildPosition(lastNode);
                    if (!new SummaryLevels(modelOf(state.map.getRoot()), modelOf(parentNode))
                            .canInsertSummaryNode(firstIndex, lastIndex, firstNode.isTopOrLeft())) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "summary range is invalid in the native layout");
                    }
                    tree.createSummary(temp, parent, first, last, !SummaryNode.isSummaryNode(modelOf(firstNode)), index);
                    text(operation, "text", true);
                }
                case "set_free" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    requireBoolean(operation, "value");
                }
                case "set_side" -> {
                    String node = BridgeSupport.requiredText(operation, "node");
                    tree.require(node);
                    if (!tree.isRootChild(node)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "set_side is qualified only for direct root children");
                    }
                    requireEnum(operation, "side", Set.of("LEFT", "RIGHT"));
                }
                case "set_style" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    validateStyle(operation.path("style"));
                }
                case "set_layout" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    validateLayout(operation.path("layout"));
                }
                case "set_cloud" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    requireBoolean(operation, "enabled");
                    if (operation.has("shape")) requireEnum(operation, "shape", Set.of("ARC", "STAR", "RECT", "ROUND_RECT"));
                    if (operation.has("color")) requireColor(operation, "color");
                }
                case "set_bookmark" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    String action = requireEnum(operation, "action", Set.of("set", "remove"));
                    if (action.equals("set")) {
                        String name = text(operation, "name", false);
                        if (name.length() > 256) throw new BridgeException(413, "LIMIT_EXCEEDED", "bookmark name exceeds 256 characters");
                        requireEnum(operation, "bookmark_type", Set.of("SELECT", "ROOT"));
                    }
                }
                case "set_formula" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    String expression = text(operation, "expression", false);
                    if (!validArithmeticFormula(expression)) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "only bounded numeric arithmetic formulas are qualified");
                    }
                }
                case "set_reminder" -> {
                    tree.require(BridgeSupport.requiredText(operation, "node"));
                    String action = requireEnum(operation, "action", Set.of("set", "remove"));
                    if (operation.has("script")) {
                        throw new BridgeException(403, "POLICY_DENIED", "reminder scripts are not qualified");
                    }
                    if (action.equals("set")) {
                        try {
                            Instant at = Instant.parse(BridgeSupport.requiredText(operation, "at"));
                            if (!java.util.Date.from(at).toInstant().equals(at)) {
                                throw new BridgeException(400, "VALIDATION_ERROR", "reminder at must have millisecond precision");
                            }
                        }
                        catch (RuntimeException invalid) { throw new BridgeException(400, "VALIDATION_ERROR", "reminder at must be an ISO instant"); }
                        requireEnum(operation, "period_unit", Set.of("MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"));
                        int period = requiredPosition(operation, "period");
                        if (period < 1 || period > 10_000) {
                            throw new BridgeException(400, "VALIDATION_ERROR", "reminder period must be between 1 and 10000");
                        }
                    }
                }
                case "delete_node" -> {
                    String node = BridgeSupport.requiredText(operation, "node");
                    tree.delete(node);
                }
                default -> throw new AssertionError(type);
            }
        }
    }

    private static Long optionalRevision(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || value.isNull()) return null;
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < 0) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be null or a non-negative integer");
        }
        return value.longValue();
    }

    private static boolean validTemporaryId(String value) {
        return value.matches("\\$[A-Za-z][A-Za-z0-9_-]{0,63}");
    }

    static boolean validArithmeticFormula(String expression) {
        if (expression == null || expression.length() < 2 || expression.length() > 256
                || !expression.matches("^=[0-9+\\-*/().%\\s]+$")) return false;
        String value = expression.substring(1).replaceAll("\\s+", "");
        int depth = 0;
        boolean expectValue = true;
        for (int index = 0; index < value.length();) {
            char character = value.charAt(index);
            if (expectValue) {
                if (character == '(') {
                    depth++;
                    index++;
                    continue;
                }
                int digits = 0;
                int dots = 0;
                while (index < value.length()) {
                    character = value.charAt(index);
                    if (Character.isDigit(character)) digits++;
                    else if (character == '.') dots++;
                    else break;
                    if (dots > 1) return false;
                    index++;
                }
                if (digits == 0) return false;
                expectValue = false;
            } else if (character == ')') {
                if (depth-- == 0) return false;
                index++;
            } else if ("+-*/%".indexOf(character) >= 0) {
                expectValue = true;
                index++;
            } else {
                return false;
            }
        }
        return !expectValue && depth == 0;
    }

    static boolean richTextEquals(String expected, String actual) {
        return expected.equals(actual == null ? "" : actual);
    }

    private static boolean requireBoolean(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isBoolean()) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be boolean");
        }
        return value.booleanValue();
    }

    private static String requireEnum(JsonNode object, String field, Set<String> allowed) {
        String value = BridgeSupport.requiredText(object, field);
        if (!allowed.contains(value)) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " is not qualified: " + value);
        }
        return value;
    }

    private static void requireColor(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isTextual() || !value.textValue().matches("#[0-9A-Fa-f]{6}")) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be #RRGGBB");
        }
    }

    private static int requireInteger(JsonNode object, String field, int minimum, int maximum) {
        JsonNode value = object.get(field);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()
                || value.intValue() < minimum || value.intValue() > maximum) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be between " + minimum + " and " + maximum);
        }
        return value.intValue();
    }

    private static void validateStyle(JsonNode style) {
        Set<String> allowed = Set.of("background_color", "text_color", "bold", "italic", "font_size", "node_shape");
        requireNonEmptyObject(style, "style", allowed);
        if (style.has("background_color")) requireColor(style, "background_color");
        if (style.has("text_color")) requireColor(style, "text_color");
        if (style.has("bold")) requireBoolean(style, "bold");
        if (style.has("italic")) requireBoolean(style, "italic");
        if (style.has("font_size")) requireInteger(style, "font_size", 6, 144);
        if (style.has("node_shape")) requireEnum(style, "node_shape", Set.of(
                "FORK", "BUBBLE", "OVAL", "RECTANGLE", "WIDE_HEXAGON", "NARROW_HEXAGON"));
    }

    private static void validateLayout(JsonNode layout) {
        Set<String> allowed = Set.of(
                "child_nodes", "horizontal_shift", "vertical_shift",
                "minimal_distance_between_children", "base_distance_to_children");
        requireNonEmptyObject(layout, "layout", allowed);
        if (layout.has("child_nodes")) requireEnum(layout, "child_nodes", Set.of(
                "TOPTOBOTTOM_BOTHSIDES_CENTERED", "TOPTOBOTTOM_RIGHT_CENTERED",
                "LEFTTORIGHT_BOTHSIDES_CENTERED", "LEFTTORIGHT_BOTTOM_CENTERED", "AUTO"));
        if (layout.has("horizontal_shift")) requireInteger(layout, "horizontal_shift", -10_000, 10_000);
        if (layout.has("vertical_shift")) requireInteger(layout, "vertical_shift", -10_000, 10_000);
        if (layout.has("minimal_distance_between_children")) {
            requireInteger(layout, "minimal_distance_between_children", 0, 10_000);
        }
        if (layout.has("base_distance_to_children")) requireInteger(layout, "base_distance_to_children", 0, 10_000);
    }

    private static void requireNonEmptyObject(JsonNode value, String field, Set<String> allowed) {
        if (value == null || !value.isObject() || value.isEmpty()) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a non-empty object");
        }
        value.fieldNames().forEachRemaining(name -> {
            if (!allowed.contains(name)) {
                throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported " + field + " property: " + name);
            }
        });
    }

    private static int requiredPosition(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt() || value.intValue() < 0) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a non-negative integer");
        }
        return value.intValue();
    }

    private static boolean attributesEqual(Node node, ArrayNode expected) {
        var attributes = node.getAttributes();
        if (attributes.size() != expected.size()) return false;
        for (int index = 0; index < expected.size(); index++) {
            if (!expected.get(index).path("name").textValue().equals(attributes.getKey(index))
                    || !expected.get(index).path("value").textValue().equals(String.valueOf(attributes.get(index)))) {
                return false;
            }
        }
        return true;
    }

    private static boolean linkEqual(
            MapRegistry.State state,
            Node node,
            JsonNode operation,
            Map<String, Node> temporary) {
        var link = node.getLink();
        return switch (operation.path("kind").textValue()) {
            case "none" -> link.getUri() == null && link.getNode() == null && link.getText() == null;
            case "uri" -> URI.create(operation.path("uri").textValue()).equals(link.getUri());
            case "node" -> link.getNode() != null
                    && link.getNode().getId().equals(resolve(state, operation.path("target").textValue(), temporary).getId());
            case "text" -> operation.path("value").textValue().equals(link.getText());
            default -> false;
        };
    }

    private static void validateConnectorProperties(JsonNode properties, boolean requireOne) {
        if (properties == null || properties.isMissingNode()) {
            if (requireOne) throw new BridgeException(400, "VALIDATION_ERROR", "connector properties are required");
            return;
        }
        if (!properties.isObject() || (requireOne && properties.isEmpty())) {
            throw new BridgeException(400, "VALIDATION_ERROR", "connector properties must be a non-empty object");
        }
        Set<String> allowed = Set.of(
                "shape", "color", "width", "start_arrow", "end_arrow",
                "source_label", "middle_label", "target_label");
        properties.fieldNames().forEachRemaining(field -> {
            if (!allowed.contains(field)) {
                throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported connector property: " + field);
            }
        });
        if (properties.has("shape") && (!properties.path("shape").isTextual()
                || !Set.of("LINE", "LINEAR_PATH", "CUBIC_CURVE", "EDGE_LIKE")
                        .contains(properties.path("shape").textValue()))) {
            throw new BridgeException(400, "VALIDATION_ERROR", "connector shape is invalid");
        }
        if (properties.has("color") && (!properties.path("color").isTextual()
                || !properties.path("color").textValue().matches("#[0-9A-Fa-f]{6}"))) {
            throw new BridgeException(400, "VALIDATION_ERROR", "connector color must be #RRGGBB");
        }
        if (properties.has("width") && (!properties.path("width").isIntegralNumber()
                || !properties.path("width").canConvertToInt()
                || properties.path("width").intValue() < 1
                || properties.path("width").intValue() > 32)) {
            throw new BridgeException(400, "VALIDATION_ERROR", "connector width must be between 1 and 32");
        }
        for (String field : List.of("start_arrow", "end_arrow")) {
            if (properties.has(field) && !properties.path(field).isBoolean()) {
                throw new BridgeException(400, "VALIDATION_ERROR", field + " must be boolean");
            }
        }
        for (String field : List.of("source_label", "middle_label", "target_label")) {
            if (properties.has(field)) {
                JsonNode value = properties.path(field);
                if (!value.isTextual() || value.textValue().length() > 1_000) {
                    throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a string up to 1000 characters");
                }
            }
        }
    }

    private static void applyConnectorProperties(Connector connector, JsonNode properties) {
        if (properties == null || properties.isMissingNode()) return;
        if (properties.has("shape")) connector.setShape(properties.path("shape").textValue());
        if (properties.has("color")) connector.setColorCode(properties.path("color").textValue());
        if (properties.has("width")) connector.setWidth(properties.path("width").intValue());
        if (properties.has("start_arrow")) connector.setStartArrow(properties.path("start_arrow").booleanValue());
        if (properties.has("end_arrow")) connector.setEndArrow(properties.path("end_arrow").booleanValue());
        if (properties.has("source_label")) connector.setSourceLabel(properties.path("source_label").textValue());
        if (properties.has("middle_label")) connector.setMiddleLabel(properties.path("middle_label").textValue());
        if (properties.has("target_label")) connector.setTargetLabel(properties.path("target_label").textValue());
    }

    private static boolean connectorPropertiesEqual(Connector connector, JsonNode properties) {
        if (properties == null || properties.isMissingNode()) return true;
        return (!properties.has("shape") || properties.path("shape").textValue().equals(connector.getShape()))
                && (!properties.has("color") || properties.path("color").textValue().equalsIgnoreCase(connector.getColorCode()))
                && (!properties.has("width") || properties.path("width").intValue() == connector.getWidth())
                && (!properties.has("start_arrow") || properties.path("start_arrow").booleanValue() == connector.hasStartArrow())
                && (!properties.has("end_arrow") || properties.path("end_arrow").booleanValue() == connector.hasEndArrow())
                && (!properties.has("source_label") || properties.path("source_label").textValue().equals(connector.getSourceLabel()))
                && (!properties.has("middle_label") || properties.path("middle_label").textValue().equals(connector.getMiddleLabel()))
                && (!properties.has("target_label") || properties.path("target_label").textValue().equals(connector.getTargetLabel()));
    }

    private static List<ConnectorRef> findConnectors(MapRegistry.State state, String connectorId) {
        List<ConnectorRef> matches = new ArrayList<>();
        ArrayDeque<Node> queue = new ArrayDeque<>();
        queue.add(state.map.getRoot());
        int count = 0;
        while (!queue.isEmpty()) {
            Node source = queue.removeFirst();
            if (++count > MapRegistry.MAX_NODES) {
                throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
            }
            for (Connector connector : source.getConnectorsOut()) {
                if (BridgeSupport.connectorId(source, connector).equals(connectorId)) {
                    matches.add(new ConnectorRef(source, connector));
                }
            }
            queue.addAll(source.getChildren());
        }
        return matches;
    }

    private static ConnectorRef requireConnector(MapRegistry.State state, String connectorId) {
        List<ConnectorRef> matches = findConnectors(state, connectorId);
        if (matches.isEmpty()) {
            throw new BridgeException(404, "NODE_NOT_FOUND", "Connector is unavailable: " + connectorId);
        }
        if (matches.size() != 1) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Connector fingerprint is ambiguous", map(
                    "connector_id", connectorId,
                    "matches", matches.size()));
        }
        return matches.get(0);
    }

    private record ConnectorRef(Node source, Connector connector) {
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
        for (String field : List.of("node", "parent", "source", "target", "first_child", "last_child", "temp_id")) {
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

    private static BridgeException viewRevisionConflict(MapRegistry.State state, long expected) {
        return new BridgeException(409, "SELECTION_CONFLICT", "Map view revision changed", map(
                "expected_view_revision", expected,
                "actual_view_revision", state.viewRevision));
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static List<String> stackSummary(Throwable error) {
        return java.util.Arrays.stream(error.getStackTrace())
                .limit(8)
                .map(StackTraceElement::toString)
                .toList();
    }

    private void removeExpiredPlans() {
        Instant now = Instant.now();
        plans.values().removeIf(plan -> now.isAfter(plan.expiresAt));
    }

    private record Plan(
            String mapId,
            long expectedRevision,
            Long expectedViewRevision,
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
        final Map<String, Node> temporary = new LinkedHashMap<>();

        Run(MapRegistry.State state, String transactionId, Integer failureAfter, String failureMode) {
            this.state = state;
            this.transactionId = transactionId;
            this.failureAfter = failureAfter;
            this.failureMode = failureMode;
        }
    }

    private static final class HistoryRun {
        final MapRegistry.State state;
        final IUndoHandler handler;
        final String action;
        final String description;
        final MapRegistry.Snapshot before;
        final long startedNanos = System.nanoTime();
        final long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        String lastHash;
        int stableSamples;
        int volatileActionsSkipped;

        HistoryRun(
                MapRegistry.State state,
                IUndoHandler handler,
                String action,
                String description,
                MapRegistry.Snapshot before) {
            this.state = state;
            this.handler = handler;
            this.action = action;
            this.description = description;
            this.before = before;
        }
    }

    private static final class ValidationTree {
        private final Map<String, String> parents = new HashMap<>();
        private final Map<String, List<String>> children = new HashMap<>();
        private final String rootId;

        ValidationTree(MapRegistry.State state) {
            rootId = state.map.getRoot().getId();
            ArrayDeque<Node> queue = new ArrayDeque<>();
            queue.add(state.map.getRoot());
            int count = 0;
            while (!queue.isEmpty()) {
                Node node = queue.removeFirst();
                if (++count > MapRegistry.MAX_NODES) {
                    throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
                }
                parents.put(node.getId(), node.getParent() == null ? null : node.getParent().getId());
                List<String> nodeChildren = node.getChildren().stream().map(Node::getId).toList();
                children.put(node.getId(), new ArrayList<>(nodeChildren));
                queue.addAll(node.getChildren());
            }
        }

        boolean contains(String reference) {
            return children.containsKey(reference);
        }

        void require(String reference) {
            if (!contains(reference)) {
                throw new BridgeException(404, "NODE_NOT_FOUND", "Node reference is unavailable: " + reference);
            }
        }

        List<String> children(String reference) {
            require(reference);
            return children.get(reference);
        }

        boolean isRootChild(String reference) {
            require(reference);
            return rootId.equals(parents.get(reference));
        }

        boolean isRoot(String reference) {
            require(reference);
            return rootId.equals(reference);
        }

        void create(String node, String parent, int position) {
            List<String> siblings = children(parent);
            if (position > siblings.size()) {
                throw new BridgeException(400, "VALIDATION_ERROR", "position exceeds the parent child count");
            }
            parents.put(node, parent);
            children.put(node, new ArrayList<>());
            siblings.add(position, node);
        }

        void requireSummaryRange(String parent, String first, String last) {
            List<String> siblings = children(parent);
            int firstIndex = siblings.indexOf(first);
            int lastIndex = siblings.indexOf(last);
            if (firstIndex < 0 || lastIndex < firstIndex) {
                throw new BridgeException(400, "VALIDATION_ERROR", "summary boundaries must be ordered direct children");
            }
        }

        void createSummary(String node, String parent, String first, String last, boolean addFirstGroup, int operationIndex) {
            List<String> siblings = children(parent);
            int firstIndex = siblings.indexOf(first);
            int lastIndex = siblings.indexOf(last);
            String group = "#summary_group_" + operationIndex;
            if (addFirstGroup) {
                String marker = "#first_group_" + operationIndex;
                parents.put(marker, parent);
                children.put(marker, new ArrayList<>());
                siblings.add(firstIndex, marker);
                lastIndex++;
            }
            parents.put(group, parent);
            children.put(group, new ArrayList<>(List.of(node)));
            parents.put(node, group);
            children.put(node, new ArrayList<>());
            siblings.add(lastIndex + 1, group);
        }

        void move(String node, String parent, int position) {
            require(node);
            require(parent);
            if (node.equals(rootId)) throw new BridgeException(400, "VALIDATION_ERROR", "root node cannot be moved");
            for (String current = parent; current != null; current = parents.get(current)) {
                if (current.equals(node)) {
                    throw new BridgeException(400, "VALIDATION_ERROR", "move_node would create a cycle");
                }
            }
            String oldParent = parents.get(node);
            List<String> oldSiblings = children(oldParent);
            oldSiblings.remove(node);
            List<String> newSiblings = children(parent);
            if (position > newSiblings.size()) {
                oldSiblings.add(node);
                throw new BridgeException(400, "VALIDATION_ERROR", "position exceeds the parent child count");
            }
            newSiblings.add(position, node);
            parents.put(node, parent);
        }

        void reorder(String parent, List<String> order) {
            List<String> current = children(parent);
            if (order.size() != current.size()
                    || new HashSet<>(order).size() != order.size()
                    || !new HashSet<>(order).equals(new HashSet<>(current))) {
                throw new BridgeException(400, "VALIDATION_ERROR", "children must be an exact permutation of direct children");
            }
            children.put(parent, new ArrayList<>(order));
        }

        void delete(String node) {
            require(node);
            if (node.equals(rootId)) throw new BridgeException(400, "VALIDATION_ERROR", "root node cannot be deleted");
            children(parents.get(node)).remove(node);
            ArrayDeque<String> queue = new ArrayDeque<>();
            queue.add(node);
            while (!queue.isEmpty()) {
                String current = queue.removeFirst();
                queue.addAll(children.get(current));
                children.remove(current);
                parents.remove(current);
            }
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
