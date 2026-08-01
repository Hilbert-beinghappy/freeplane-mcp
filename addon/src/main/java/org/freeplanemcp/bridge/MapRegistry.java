package org.freeplanemcp.bridge;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;

import org.freeplane.api.Connector;
import org.freeplane.api.Controller;
import org.freeplane.api.MindMap;
import org.freeplane.api.Node;
import org.freeplane.api.NodeChangeListener;
import org.freeplane.features.map.IMapChangeListener;
import org.freeplane.features.map.MapChangeEvent;
import org.freeplane.features.map.MapModel;
import org.freeplane.features.map.NodeDeletionEvent;
import org.freeplane.features.map.NodeModel;
import org.freeplane.features.map.NodeMoveEvent;
import org.freeplane.plugin.script.proxy.AbstractProxy;

import javax.swing.SwingUtilities;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.freeplanemcp.bridge.BridgeSupport.BridgeException;
import static org.freeplanemcp.bridge.BridgeSupport.map;

final class MapRegistry implements AutoCloseable {
    static final int MAX_NODES = 10_000;
    private static final int MAX_DEPTH = 1_000;
    private static final int MAX_EVENTS = 50_000;
    private static final long MAX_EVENT_BYTES = 64L * 1024 * 1024;

    private final Controller controller;
    private final String instanceId;
    private final IdentityHashMap<MapModel, State> statesByModel = new IdentityHashMap<>();
    private final Map<String, State> statesById = new HashMap<>();
    private final Deque<EventRecord> events = new ArrayDeque<>();
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean pollQueued = new AtomicBoolean();
    private long eventSequence;
    private long eventBytes;
    private String eventSource;
    private String transactionId;
    private String expectedUiMarker;
    private long expectedUiStartedMillis;
    private Long uiDetectionLatencyMillis;
    private long suppressListenersUntilMillis;
    private double lastSnapshotMillis;
    private double maxSnapshotMillis;

    MapRegistry(Controller controller, String instanceId) {
        this.controller = controller;
        this.instanceId = instanceId;
        ThreadFactory daemonFactory = runnable -> {
            Thread thread = new Thread(runnable, "freeplane-mcp-snapshot");
            thread.setDaemon(true);
            return thread;
        };
        scheduler = Executors.newSingleThreadScheduledExecutor(daemonFactory);
    }

    void start() {
        assertMainThread();
        refreshMaps();
        scheduler.scheduleAtFixedRate(this::queuePoll, 250, 250, TimeUnit.MILLISECONDS);
    }

    private void queuePoll() {
        if (!pollQueued.compareAndSet(false, true)) return;
        try {
            controller.getMainThreadExecutorService().execute(this::beginPoll);
        } catch (RuntimeException error) {
            pollQueued.set(false);
            throw error;
        }
    }

    private void beginPoll() {
        try {
            assertMainThread();
            refreshMaps();
            pollNext(List.copyOf(statesById.values()), 0);
        } catch (RuntimeException error) {
            pollQueued.set(false);
            throw error;
        }
    }

    private void pollNext(List<State> states, int index) {
        try {
            assertMainThread();
            if (index >= states.size()) {
                pollQueued.set(false);
                return;
            }
            State state = states.get(index);
            if (statesById.get(state.mapId) == state) {
                reconcile(state, "snapshot.reconciled", List.of("unknown"), List.of());
                reconcileView(state);
            }
            controller.getMainThreadExecutorService().execute(() -> pollNext(states, index + 1));
        } catch (RuntimeException error) {
            pollQueued.set(false);
            throw error;
        }
    }

    private void refreshMaps() {
        assertMainThread();
        Set<MapModel> seen = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
        for (MindMap map : controller.getOpenMindMaps()) {
            MapModel model = modelOf(map);
            seen.add(model);
            State state = statesByModel.get(model);
            if (state == null) {
                state = attach(map, model);
                statesByModel.put(model, state);
                statesById.put(state.mapId, state);
                appendEvent(state, "map.opened", "system", List.of(), List.of("lifecycle"), null);
            } else {
                state.map = map;
            }
        }

        for (State state : List.copyOf(statesById.values())) {
            if (seen.contains(state.model)) continue;
            state.map.removeListener(state.publicListener);
            state.model.removeMapChangeListener(state.internalListener);
            appendEvent(state, "map.closed", "system", List.of(), List.of("lifecycle"), null);
            statesByModel.remove(state.model);
            statesById.remove(state.mapId);
        }
    }

    private State attach(MindMap map, MapModel model) {
        State state = new State("fpmap:" + UUID.randomUUID(), map, model);
        state.publicListener = event -> {
            if (listenersSuppressed()) return;
            reconcile(
                    state,
                    "node.updated",
                    List.of(event.getChangedElement().name().toLowerCase(Locale.ROOT)),
                    nodeIds(event.getNode().getId()));
        };
        state.internalListener = new IMapChangeListener() {
            @Override
            public void mapChanged(MapChangeEvent event) {
                if (listenersSuppressed()) return;
                reconcile(state, "map.updated", List.of(String.valueOf(event.getProperty())), List.of());
            }

            @Override
            public void onNodeDeleted(NodeDeletionEvent event) {
                if (listenersSuppressed()) return;
                reconcile(state, "node.deleted", List.of("children"), nodeIds(event.node.getID()));
            }

            @Override
            public void onNodeInserted(NodeModel parent, NodeModel child, int newIndex) {
                if (listenersSuppressed()) return;
                reconcile(state, "node.created", List.of("children"), nodeIds(parent.getID(), child.getID()));
            }

            @Override
            public void onNodeMoved(NodeMoveEvent event) {
                if (listenersSuppressed()) return;
                reconcile(state, "node.moved", List.of("parent", "position"), nodeIds(event.child.getID()));
            }
        };
        map.addListener(state.publicListener);
        model.addMapChangeListener(state.internalListener);
        state.snapshot = capture(state);
        state.viewSignature = viewSignature(state);
        state.savedContentRevision = 0;
        state.fileStamp = fileStamp(map.getFile());
        state.wasSaved = map.isSaved();
        return state;
    }

    private static List<String> nodeIds(String... values) {
        return java.util.Arrays.stream(values).filter(java.util.Objects::nonNull).toList();
    }

    private static MapModel modelOf(MindMap map) {
        if (!(map instanceof AbstractProxy<?> proxy) || !(proxy.getDelegate() instanceof MapModel model)) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Freeplane map proxy is incompatible with the qualified build");
        }
        return model;
    }

    Map<String, Object> healthData() {
        assertMainThread();
        refreshMaps();
        State active = activeState();
        return map(
                "map_count", statesById.size(),
                "active_map_id", active == null ? null : active.mapId,
                "selected_node_ids", active == null ? List.of() : selectedIds(active),
                "event_seq", eventSequence,
                "event_count", events.size(),
                "event_bytes", eventBytes,
                "cursor", BridgeSupport.cursor(instanceId, eventSequence),
                "ui_detection_latency_ms", uiDetectionLatencyMillis,
                "last_snapshot_ms", lastSnapshotMillis,
                "max_snapshot_ms", maxSnapshotMillis,
                "main_thread", SwingUtilities.isEventDispatchThread());
    }

    List<Map<String, Object>> listMaps() {
        assertMainThread();
        refreshMaps();
        List<State> states = new ArrayList<>(statesById.values());
        states.sort(Comparator.comparing(state -> state.mapId));
        return states.stream().map(this::summary).toList();
    }

    private Map<String, Object> summary(State state) {
        File file = state.map.getFile();
        FileStamp currentFileStamp = fileStamp(file);
        updateSaveState(state, currentFileStamp);
        return map(
                "map_id", state.mapId,
                "name", state.map.getName(),
                "title", state.map.getName(),
                "file_identity", fileIdentity(file),
                "unsaved", file == null,
                "active", activeStateWithoutRefresh() == state,
                "read_only", file != null && Files.exists(file.toPath()) && !Files.isWritable(file.toPath()),
                "content_revision", state.contentRevision,
                "view_revision", state.viewRevision,
                "saved_content_revision", state.savedContentRevision,
                "dirty", !state.map.isSaved(),
                "recovery_required", state.recoveryRequired,
                "root_node_id", state.map.getRoot().getId(),
                "snapshot_sha256", state.snapshot.hash,
                "node_count", state.snapshot.nodeCount,
                "node_count_estimate", state.snapshot.nodeCount,
                "file_external_change", state.fileStamp != null
                        && currentFileStamp != null
                        && !state.fileStamp.equals(currentFileStamp));
    }

    private FileStamp fileStamp(File file) {
        if (file == null) return null;
        try {
            Path canonical = file.toPath().toAbsolutePath().normalize().toRealPath();
            BasicFileAttributes attributes = Files.readAttributes(
                    canonical, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            return new FileStamp(canonical.toString(), attributes.size(), attributes.lastModifiedTime().toMillis());
        } catch (IOException | SecurityException unavailable) {
            return null;
        }
    }

    private Map<String, Object> fileIdentity(File file) {
        if (file == null) return null;
        Path path = file.toPath().toAbsolutePath().normalize();
        try {
            Path canonical = Files.exists(path) ? path.toRealPath() : path;
            BasicFileAttributes attributes = Files.exists(canonical)
                    ? Files.readAttributes(canonical, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)
                    : null;
            return map(
                    "path", canonical.toString(),
                    "file_key", attributes == null ? null : String.valueOf(attributes.fileKey()),
                    "size", attributes == null ? null : attributes.size(),
                    "mtime", attributes == null ? null : attributes.lastModifiedTime().toInstant().toString(),
                    "sha256", null);
        } catch (IOException | SecurityException error) {
            return map("path", path.toString(), "unavailable", true, "sha256", null);
        }
    }

    Map<String, Object> read(JsonNode request) {
        assertMainThread();
        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        reconcile(state, "snapshot.reconciled", List.of("readback"), List.of());
        String nodeId = request.path("node_id").isTextual() ? request.path("node_id").textValue() : null;
        Object content;
        if (nodeId == null) {
            content = state.snapshot.data;
        } else {
            Node node = requireNode(state, nodeId);
            Counter counter = new Counter();
            content = captureNode(node, counter, 0);
        }
        return map(
                "map", summary(state),
                "content", content);
    }

    Map<String, Object> search(JsonNode request) {
        assertMainThread();
        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        String query = BridgeSupport.requiredText(request, "query");
        if (query.length() > 512) {
            throw new BridgeException(413, "LIMIT_EXCEEDED", "query exceeds 512 characters");
        }
        int limit = BridgeSupport.optionalInt(request, "limit", 100, 1, 1_000);
        String needle = query.toLowerCase(Locale.ROOT);
        List<Map<String, Object>> matches = new ArrayList<>();
        Deque<Node> queue = new ArrayDeque<>();
        queue.add(state.map.getRoot());
        int visited = 0;
        while (!queue.isEmpty() && matches.size() < limit) {
            Node node = queue.removeFirst();
            if (++visited > MAX_NODES) {
                throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
            }
            if (node.getText().toLowerCase(Locale.ROOT).contains(needle)) {
                matches.add(map("node_id", node.getId(), "text", node.getText()));
            }
            queue.addAll(node.getChildren());
        }
        return map(
                "map_id", state.mapId,
                "content_revision", state.contentRevision,
                "matches", matches,
                "truncated", matches.size() == limit && !queue.isEmpty());
    }

    Map<String, Object> changes(JsonNode request) {
        assertMainThread();
        String cursor = request.path("cursor").isTextual() ? request.path("cursor").textValue() : null;
        long from = cursor == null ? eventSequence : BridgeSupport.decodeCursor(cursor, instanceId);
        if (from > eventSequence) {
            throw new BridgeException(400, "VALIDATION_ERROR", "cursor is ahead of the current event journal");
        }
        int limit = BridgeSupport.optionalInt(request, "limit", 1_000, 1, 5_000);
        String mapId = request.path("map_id").isTextual() ? request.path("map_id").textValue() : null;
        if (mapId != null) requireState(mapId);
        long oldest = events.isEmpty() ? eventSequence + 1 : events.getFirst().sequence;
        if (from < oldest - 1) {
            throw new BridgeException(409, "CURSOR_EXPIRED", "cursor predates the retained event journal", map(
                    "resync_required", true,
                    "oldest_cursor", BridgeSupport.cursor(instanceId, Math.max(0, oldest - 1)),
                    "current_cursor", BridgeSupport.cursor(instanceId, eventSequence)));
        }
        List<Map<String, Object>> selected = new ArrayList<>();
        long scanned = from;
        for (EventRecord event : events) {
            if (event.sequence <= from) continue;
            if (selected.size() == limit) break;
            scanned = event.sequence;
            if (mapId == null || mapId.equals(event.data.get("map_id"))) selected.add(event.data);
        }
        if (selected.size() < limit) scanned = eventSequence;
        return map(
                "events", selected,
                "next_cursor", BridgeSupport.cursor(instanceId, scanned),
                "current_cursor", BridgeSupport.cursor(instanceId, eventSequence),
                "resync_required", false,
                "maps", listMaps());
    }

    State requireState(String mapId) {
        State state = statesById.get(mapId);
        if (state == null) throw new BridgeException(404, "MAP_NOT_FOUND", "Map is not open: " + mapId);
        return state;
    }

    Node requireNode(State state, String nodeId) {
        Node node = findNode(state, nodeId);
        if (node == null) throw new BridgeException(404, "NODE_NOT_FOUND", "Node is not present in map: " + nodeId);
        return node;
    }

    Node findNode(State state, String nodeId) {
        Deque<Node> queue = new ArrayDeque<>();
        queue.add(state.map.getRoot());
        int visited = 0;
        while (!queue.isEmpty()) {
            Node node = queue.removeFirst();
            if (++visited > MAX_NODES) {
                throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
            }
            if (nodeId.equals(node.getId())) return node;
            queue.addAll(node.getChildren());
        }
        return null;
    }

    State activeState() {
        Node selected = controller.getSelected();
        if (selected == null) selected = controller.getViewRoot();
        if (selected == null) return null;
        return statesByModel.get(modelOf(selected.getMindMap()));
    }

    Snapshot capture(State state) {
        assertMainThread();
        long startedNanos = System.nanoTime();
        Counter counter = new Counter();
        Map<String, Object> data = map(
                "schema_version", 1,
                "map_id", state.mapId,
                "name", state.map.getName(),
                "background_color", state.map.getBackgroundColorCode(),
                "root", captureNode(state.map.getRoot(), counter, 0));
        Snapshot snapshot = new Snapshot(data, logicalSnapshotHash(data), counter.value);
        lastSnapshotMillis = (System.nanoTime() - startedNanos) / 1_000_000.0;
        maxSnapshotMillis = Math.max(maxSnapshotMillis, lastSnapshotMillis);
        return snapshot;
    }

    private Map<String, Object> captureNode(Node node, Counter counter, int depth) {
        if (++counter.value > MAX_NODES) {
            throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
        }
        if (depth > MAX_DEPTH) {
            throw new BridgeException(413, "LIMIT_EXCEEDED", "map depth exceeds 1000");
        }

        var nodeAttributes = node.getAttributes();
        List<Map<String, Object>> attributes = nodeAttributes.size() == 0
                ? List.of()
                : new ArrayList<>(nodeAttributes.size());
        for (int index = 0; index < nodeAttributes.size(); index++) {
            attributes.add(map(
                    "name", nodeAttributes.getKey(index),
                    "value", scalar(nodeAttributes.get(index))));
        }

        var outgoingConnectors = node.getConnectorsOut();
        List<Map<String, Object>> connectors = outgoingConnectors.isEmpty()
                ? List.of()
                : new ArrayList<>(outgoingConnectors.size());
        for (Connector connector : outgoingConnectors) {
            connectors.add(map(
                    "connector_id", BridgeSupport.connectorId(node, connector),
                    "target_id", connector.getTarget().getId(),
                    "shape", connector.getShape(),
                    "color", connector.getColorCode(),
                    "width", connector.getWidth(),
                    "start_arrow", connector.hasStartArrow(),
                    "end_arrow", connector.hasEndArrow(),
                    "source_label", connector.getSourceLabel(),
                    "middle_label", connector.getMiddleLabel(),
                    "target_label", connector.getTargetLabel()));
        }
        if (connectors.size() > 1) {
            connectors.sort(Comparator.comparing(item -> BridgeSupport.canonicalHash(
                    BridgeSupport.JSON.valueToTree(item))));
        }

        var link = node.getLink();
        var linkUri = link.getUri();
        var linkTarget = link.getNode();
        var linkText = link.getText();
        Object links = linkText == null && linkUri == null && linkTarget == null
                ? null
                : map(
                        "text", linkText,
                        "uri", linkUri == null ? null : linkUri.toString(),
                        "target_node_id", linkTarget == null ? null : linkTarget.getId());
        var style = node.getStyle();
        var created = node.getCreatedAt();
        var modified = node.getLastModifiedAt();
        var tags = node.getTags().getTags();
        var icons = node.getIcons().getIcons();
        var nodeChildren = node.getChildren();
        List<Map<String, Object>> children = nodeChildren.isEmpty()
                ? List.of()
                : new ArrayList<>(nodeChildren.size());
        for (Node child : nodeChildren) children.add(captureNode(child, counter, depth + 1));

        return map(
                "id", node.getId(),
                "text", node.getText(),
                "details", node.getDetailsText(),
                "note", node.getNoteText(),
                "attributes", attributes,
                "tags", List.copyOf(tags),
                "icons", List.copyOf(icons),
                "links", links,
                "style", map(
                        "name", style.getName(),
                        "background_color", style.getBackgroundColorCode(),
                        "text_color", style.getTextColorCode()),
                "layout", map(
                        "orientation", String.valueOf(node.getLayoutOrientation()),
                        "child_nodes", String.valueOf(node.getChildNodesLayout()),
                        "free", node.isFree()),
                "timestamps", map(
                        "created", created == null ? null : created.toInstant().toString(),
                        "modified", modified == null ? null : modified.toInstant().toString()),
                "encryption", null,
                "folded", node.isFolded(),
                "connectors", connectors,
                "children", children);
    }

    private static Object scalar(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static String logicalSnapshotHash(Map<String, Object> data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (JsonGenerator json = BridgeSupport.JSON.getFactory().createGenerator(
                    new DigestOutputStream(OutputStream.nullOutputStream(), digest))) {
                writeLogicalSnapshot(json, data, false);
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (IOException | NoSuchAlgorithmException failure) {
            throw new IllegalStateException("Could not hash the canonical map snapshot", failure);
        }
    }

    private static void writeLogicalSnapshot(JsonGenerator json, Object value, boolean timestamps) throws IOException {
        if (value == null) {
            json.writeNull();
        } else if (value instanceof Map<?, ?> object) {
            json.writeStartObject();
            for (Map.Entry<?, ?> entry : object.entrySet()) {
                String key = String.valueOf(entry.getKey());
                // Freeplane rewrites this volatile metadata during redo; reads still expose its current value.
                if (timestamps && key.equals("modified")) continue;
                json.writeFieldName(key);
                writeLogicalSnapshot(json, entry.getValue(), key.equals("timestamps"));
            }
            json.writeEndObject();
        } else if (value instanceof Collection<?> array) {
            json.writeStartArray();
            for (Object item : array) writeLogicalSnapshot(json, item, false);
            json.writeEndArray();
        } else if (value instanceof String text) {
            json.writeString(text);
        } else if (value instanceof Boolean bool) {
            json.writeBoolean(bool);
        } else if (value instanceof Number number) {
            json.writeNumber(number.toString());
        } else {
            throw new IllegalStateException("Unsupported canonical snapshot value: " + value.getClass().getName());
        }
    }

    Snapshot reconcile(State state, String kind, List<String> fields, List<String> nodeIds) {
        assertMainThread();
        Snapshot actual = capture(state);
        boolean changed = !actual.hash.equals(state.snapshot.hash);
        state.snapshot = actual;
        if (changed) {
            state.contentRevision++;
            appendEvent(state, kind, sourceFor(state), nodeIds, fields, transactionId);
            detectUiEdit(state);
        }
        updateSaveState(state, fileStamp(state.map.getFile()));
        return actual;
    }

    private void updateSaveState(State state, FileStamp currentFileStamp) {
        boolean saved = state.map.isSaved();
        if (saved && !state.wasSaved) {
            state.savedContentRevision = state.contentRevision;
            state.fileStamp = currentFileStamp;
        }
        state.wasSaved = saved;
    }

    private void detectUiEdit(State state) {
        if (uiDetectionLatencyMillis != null) return;
        if (expectedUiMarker == null || !expectedUiMarker.equals(state.map.getRoot().getText())) return;
        uiDetectionLatencyMillis = Math.max(0, System.currentTimeMillis() - expectedUiStartedMillis);
    }

    void expectUiEdit(String marker, long startedMillis) {
        assertMainThread();
        expectedUiMarker = marker;
        expectedUiStartedMillis = startedMillis;
    }

    Map<String, Object> qualificationSilentText(String mapId, String value) {
        assertMainThread();
        State state = requireState(mapId);
        suppressListenersUntilMillis = System.currentTimeMillis() + 1_000;
        state.map.getRoot().setText(value);
        return map("map_id", mapId, "pending_reconciliation", true);
    }

    private boolean listenersSuppressed() {
        return System.currentTimeMillis() < suppressListenersUntilMillis;
    }

    Map<String, Object> qualificationFillEvents(String mapId, int count) {
        assertMainThread();
        State state = requireState(mapId);
        for (int index = 0; index < count; index++) {
            appendEvent(state, "qualification.synthetic", "system", List.of(), List.of("qualification"), null);
        }
        return map("event_count", events.size(), "event_bytes", eventBytes, "cursor", BridgeSupport.cursor(instanceId, eventSequence));
    }

    private void reconcileView(State state) {
        String signature = viewSignature(state);
        if (signature.equals(state.viewSignature)) return;
        state.viewSignature = signature;
        state.viewRevision++;
        appendEvent(state, "view.updated", sourceFor(state), selectedIds(state), List.of("selection", "view_root", "zoom"), transactionId);
    }

    private String viewSignature(State state) {
        State active = activeStateWithoutRefresh();
        if (active != state) return "inactive";
        StringBuilder value = new StringBuilder("active|");
        for (Node node : controller.getSelecteds()) value.append(node.getId()).append(',');
        Node root = controller.getViewRoot();
        return value.append('|').append(root == null ? "" : root.getId()).append('|').append(controller.getZoom()).toString();
    }

    private State activeStateWithoutRefresh() {
        Node selected = controller.getSelected();
        if (selected == null) selected = controller.getViewRoot();
        if (selected == null) return null;
        return statesByModel.get(modelOf(selected.getMindMap()));
    }

    private List<String> selectedIds(State state) {
        if (activeStateWithoutRefresh() != state) return List.of();
        return controller.getSelecteds().stream().map(Node::getId).toList();
    }

    private String sourceFor(State state) {
        if (eventSource != null) return eventSource;
        return state.model.isUndoActionRunning() ? "system" : "user_gui";
    }

    private void appendEvent(
            State state,
            String kind,
            String source,
            List<String> nodeIds,
            List<String> fields,
            String eventTransactionId) {
        long sequence = ++eventSequence;
        Map<String, Object> data = map(
                "event_seq", sequence,
                "map_id", state.mapId,
                "content_revision", state.contentRevision,
                "view_revision", state.viewRevision,
                "source", source,
                "kind", kind,
                "persistence_effect", kind.startsWith("view.")
                        || kind.equals("map.opened")
                        || kind.equals("map.closed")
                        || kind.startsWith("qualification.") ? "session_only" : "persistent",
                "affected_node_ids", distinct(nodeIds),
                "changed_fields", distinct(fields),
                "transaction_id", eventTransactionId,
                "timestamp", Instant.now().toString());
        int bytes = BridgeSupport.jsonBytes(data).length;
        events.addLast(new EventRecord(sequence, data, bytes));
        eventBytes += bytes;
        while (events.size() > MAX_EVENTS || eventBytes > MAX_EVENT_BYTES) {
            eventBytes -= events.removeFirst().bytes;
        }
    }

    private static List<String> distinct(Collection<String> values) {
        return List.copyOf(new LinkedHashSet<>(values));
    }

    <T> T withEventContext(String source, String transaction, Callable<T> action) {
        assertMainThread();
        String previousSource = eventSource;
        String previousTransaction = transactionId;
        eventSource = source;
        transactionId = transaction;
        try {
            return action.call();
        } catch (RuntimeException runtime) {
            throw runtime;
        } catch (Exception checked) {
            throw new IllegalStateException(checked);
        } finally {
            eventSource = previousSource;
            transactionId = previousTransaction;
        }
    }

    void markRecoveryRequired(State state) {
        state.recoveryRequired = true;
        appendEvent(state, "map.recovery_required", "system", List.of(), List.of("recovery"), transactionId);
    }

    private static void assertMainThread() {
        if (!SwingUtilities.isEventDispatchThread()) {
            throw new IllegalStateException("Freeplane model access escaped the main thread");
        }
    }

    @Override
    public void close() {
        assertMainThread();
        scheduler.shutdownNow();
        for (State state : List.copyOf(statesById.values())) {
            state.map.removeListener(state.publicListener);
            state.model.removeMapChangeListener(state.internalListener);
        }
        statesById.clear();
        statesByModel.clear();
        events.clear();
        eventBytes = 0;
    }

    static final class State {
        final String mapId;
        final MapModel model;
        MindMap map;
        NodeChangeListener publicListener;
        IMapChangeListener internalListener;
        Snapshot snapshot;
        long contentRevision;
        long viewRevision;
        long savedContentRevision;
        String viewSignature = "";
        FileStamp fileStamp;
        boolean wasSaved;
        boolean recoveryRequired;

        State(String mapId, MindMap map, MapModel model) {
            this.mapId = mapId;
            this.map = map;
            this.model = model;
        }
    }

    record Snapshot(Map<String, Object> data, String hash, int nodeCount) {
    }

    private record EventRecord(long sequence, Map<String, Object> data, int bytes) {
    }

    private record FileStamp(String path, long size, long modifiedMillis) {
    }

    private static final class Counter {
        int value;
    }
}
