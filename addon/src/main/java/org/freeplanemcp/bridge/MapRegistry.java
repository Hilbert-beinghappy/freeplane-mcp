package org.freeplanemcp.bridge;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;

import org.freeplane.api.Connector;
import org.freeplane.api.Controller;
import org.freeplane.api.MindMap;
import org.freeplane.api.Node;
import org.freeplane.api.NodeCondition;
import org.freeplane.api.NodeChangeListener;
import org.freeplane.core.ui.CaseSensitiveFileNameExtensionFilter;
import org.freeplane.core.resources.ResourceController;
import org.freeplane.features.export.mindmapmode.ExportController;
import org.freeplane.features.export.mindmapmode.IExportEngine;
import org.freeplane.features.filter.Filter;
import org.freeplane.features.filter.FilterController;
import org.freeplane.features.map.AlwaysUnfoldedNode;
import org.freeplane.features.map.IMapChangeListener;
import org.freeplane.features.map.MapChangeEvent;
import org.freeplane.features.map.MapModel;
import org.freeplane.features.map.NodeDeletionEvent;
import org.freeplane.features.map.NodeModel;
import org.freeplane.features.map.NodeMoveEvent;
import org.freeplane.features.map.SummaryNode;
import org.freeplane.features.url.mindmapmode.MFileManager;
import org.freeplane.plugin.script.proxy.AbstractProxy;
import org.freeplane.view.swing.map.NodeView;

import javax.swing.SwingUtilities;
import javax.swing.filechooser.FileFilter;
import java.awt.Window;
import java.awt.Rectangle;
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
        long recoveryRequiredMaps = statesById.values().stream().filter(state -> state.recoveryRequired).count();
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
                "recovery_required", recoveryRequiredMaps > 0,
                "recovery_required_map_count", recoveryRequiredMaps,
                "main_thread", SwingUtilities.isEventDispatchThread());
    }

    List<Map<String, Object>> listMaps() {
        assertMainThread();
        refreshMaps();
        List<State> states = new ArrayList<>(statesById.values());
        states.sort(Comparator.comparing(state -> state.mapId));
        return states.stream().map(this::summary).toList();
    }

    Map<String, Object> document(JsonNode request) {
        assertMainThread();
        String action = BridgeSupport.requiredText(request, "action");
        if (Set.of("create", "create_from_template", "open").contains(action)) {
            MindMap created = switch (action) {
                case "create" -> newDefaultMapWithoutDialog();
                case "create_from_template" -> controller.newMapFromTemplate(
                        requireMmPath(request, "template_path", true).toFile());
                case "open" -> controller.load(requireMmPath(request, "path", true).toFile()).withView().getMindMap();
                default -> throw new AssertionError(action);
            };
            refreshMaps();
            State state = statesByModel.get(modelOf(created));
            if (state == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Document did not enter the live registry");
            reconcile(state, "map.lifecycle", List.of("lifecycle"), List.of());
            return map("action", action, "map", summary(state));
        }

        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        reconcile(state, "snapshot.reconciled", List.of("document_precondition"), List.of());
        long expected = BridgeSupport.requiredNonNegativeLong(request, "expected_content_revision");
        if (state.contentRevision != expected) {
            throw new BridgeException(409, "REVISION_CONFLICT", "Map content revision changed", map(
                    "expected_content_revision", expected,
                    "actual_content_revision", state.contentRevision));
        }
        if (state.recoveryRequired) {
            throw new BridgeException(409, "RECOVERY_REQUIRED", "Map requires recovery before document operations");
        }

        switch (action) {
            case "save" -> {
                if (state.map.getFile() == null) {
                    throw new BridgeException(400, "VALIDATION_ERROR", "Unsaved maps require save_as with an explicit path");
                }
                require(state.map.save(false) && state.map.isSaved(), "Native save did not complete");
                reconcile(state, "map.saved", List.of("saved"), List.of());
                return map("action", action, "map", summary(state));
            }
            case "save_as" -> {
                Path target = requireMmPath(request, "path", false);
                boolean overwriteAuthorized = request.path("overwrite_authorized").asBoolean(false);
                if (Files.exists(target, LinkOption.NOFOLLOW_LINKS) && !overwriteAuthorized) {
                    throw new BridgeException(409, "CONFIRMATION_REQUIRED", "Existing save_as target requires confirmation");
                }
                require(state.map.saveAs(target.toFile()) && state.map.isSaved(), "Native save_as did not complete");
                reconcile(state, "map.saved_as", List.of("saved", "file"), List.of());
                return map("action", action, "map", summary(state));
            }
            case "close" -> {
                String mode = BridgeSupport.requiredText(request, "close_mode");
                if (!Set.of("save_then_close", "discard_then_close", "cancel").contains(mode)) {
                    throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported close mode");
                }
                if (mode.equals("cancel")) return map("action", action, "cancelled", true, "map", summary(state));
                if (!state.map.isSaved() && !request.path("destructive_authorized").asBoolean(false)) {
                    throw new BridgeException(409, "CONFIRMATION_REQUIRED", "Closing a dirty map requires confirmation");
                }
                if (mode.equals("save_then_close")) {
                    if (state.map.getFile() == null) {
                        throw new BridgeException(400, "VALIDATION_ERROR", "save_then_close requires a saved map path");
                    }
                    require(state.map.save(false) && state.map.isSaved(), "Save before close did not complete");
                }
                boolean closed = state.map.close(mode.equals("discard_then_close"), false);
                require(closed, "Native close did not complete");
                refreshMaps();
                require(!statesById.containsKey(state.mapId), "Closed map remained in the live registry");
                return map("action", action, "closed", true, "closed_map_id", state.mapId);
            }
            case "revert" -> {
                if (!request.path("destructive_authorized").asBoolean(false)) {
                    throw new BridgeException(409, "CONFIRMATION_REQUIRED", "Revert requires confirmation");
                }
                File file = state.map.getFile();
                if (file == null) throw new BridgeException(400, "VALIDATION_ERROR", "Unsaved maps cannot be reverted");
                Path source = requireExistingMmPath(file.toPath());
                require(state.map.close(true, false), "Map did not close for revert");
                MindMap reopened = controller.load(source.toFile()).withView().getMindMap();
                refreshMaps();
                State reopenedState = statesByModel.get(modelOf(reopened));
                if (reopenedState == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Reverted map did not reopen");
                return map("action", action, "replaced_map_id", state.mapId, "map", summary(reopenedState));
            }
            default -> throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported document action: " + action);
        }
    }

    private MindMap newDefaultMapWithoutDialog() {
        MFileManager files = MFileManager.getController(
                org.freeplane.features.mode.Controller.getCurrentModeController());
        File template = files == null ? null : files.defaultTemplateFile();
        if (template == null) throw new BridgeException(503, "CAPABILITY_UNAVAILABLE", "Freeplane has no default template");
        return controller.newMapFromTemplate(template);
    }

    Map<String, Object> exportMap(JsonNode request) {
        assertMainThread();
        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        reconcile(state, "snapshot.reconciled", List.of("export_precondition"), List.of());
        long expected = BridgeSupport.requiredNonNegativeLong(request, "expected_content_revision");
        if (state.contentRevision != expected) {
            throw new BridgeException(409, "REVISION_CONFLICT", "Map content revision changed", map(
                    "expected_content_revision", expected,
                    "actual_content_revision", state.contentRevision));
        }
        if (activeStateWithoutRefresh() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "Qualified export requires the active Freeplane map");
        }
        if (!request.path("scope").asText("").equals("map")) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Only map-scope export is qualified");
        }
        String format = BridgeSupport.requiredText(request, "format_id");
        if (!Set.of("png", "pdf", "svg", "html").contains(format)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Export format is not qualified: " + format);
        }
        Path destination = requireExportPath(request, format);
        if (!(state.map instanceof AbstractProxy<?> proxy)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Qualified export internals are unavailable");
        }
        ExportController exports = ExportController.getController(proxy.getModeController());
        if (exports == null) throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Export controller is unavailable");
        IExportEngine engine = null;
        for (Map.Entry<FileFilter, IExportEngine> entry : exports.getMapExportEngines().entrySet()) {
            if (entry.getKey() instanceof CaseSensitiveFileNameExtensionFilter filter
                    && format.equalsIgnoreCase(filter.getExtensionProposal())) {
                if (format.equals("html") && !entry.getValue().getClass().getName()
                        .equals("org.freeplane.features.export.mindmapmode.ExportToHTML")) continue;
                if (engine != null) throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Export format is ambiguous: " + format);
                engine = entry.getValue();
            }
        }
        if (engine == null) throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Export engine is unavailable: " + format);
        engine.export(List.of(nodeModelOf(state.map.getRoot())), destination.toFile());
        awaitExportArtifact(destination);
        return map(
                "map_id", state.mapId,
                "format_id", format,
                "scope", "map",
                "destination", destination.toString(),
                "content_revision", state.contentRevision,
                "view_revision", state.viewRevision);
    }

    Map<String, Object> guiState(JsonNode request) {
        assertMainThread();
        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        reconcile(state, "snapshot.reconciled", List.of("gui_precondition"), List.of());
        reconcileView(state);
        if (activeStateWithoutRefresh() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "GUI actions require the requested map to be active");
        }
        if (request.has("expected_content_revision")) {
            long expected = BridgeSupport.requiredNonNegativeLong(request, "expected_content_revision");
            if (state.contentRevision != expected) {
                throw new BridgeException(409, "REVISION_CONFLICT", "Map content revision changed", map(
                        "expected_content_revision", expected,
                        "actual_content_revision", state.contentRevision));
            }
        }
        if (request.has("expected_view_revision")) {
            long expected = BridgeSupport.requiredNonNegativeLong(request, "expected_view_revision");
            if (state.viewRevision != expected) {
                throw new BridgeException(409, "REVISION_CONFLICT", "Map view revision changed", map(
                        "expected_view_revision", expected,
                        "actual_view_revision", state.viewRevision));
            }
        }
        return map(
                "map_id", state.mapId,
                "content_revision", state.contentRevision,
                "view_revision", state.viewRevision,
                "locale", ResourceController.getResourceController().getLanguageCode(),
                "presentation", presentationState(state),
                "print_preview_open", printPreviewOpen());
    }

    Map<String, Object> qualificationPresentation(String mapId) {
        assertMainThread();
        State state = requireState(mapId);
        if (activeStateWithoutRefresh() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "Presentation fixture requires the active map");
        }
        Object controller = presentationController(state);
        Object mapPresentations = call(controller, "getPresentations", new Class<?>[]{MapModel.class}, state.model);
        Object presentations = publicField(mapPresentations, "presentations");
        if (intCall(presentations, "getSize") != 0) {
            throw new BridgeException(409, "ACTION_PRECONDITION_FAILED", "Qualification map already contains presentations");
        }
        call(presentations, "add", new Class<?>[]{String.class}, "Freeplane MCP qualification");
        Object presentation = call(presentations, "getCurrentElement", new Class<?>[]{});
        if (presentation == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Presentation was not created");
        Object slides = publicField(presentation, "slides");
        call(slides, "add", new Class<?>[]{String.class}, "First");
        Object first = call(slides, "getCurrentElement", new Class<?>[]{});
        if (first == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "First slide was not created");
        call(first, "setSelectedNodeIds", new Class<?>[]{Set.class}, Set.of(state.model.getRootNode().getID()));
        call(slides, "add", new Class<?>[]{String.class}, "Second");
        Object second = call(slides, "getCurrentElement", new Class<?>[]{});
        if (second == null) throw new BridgeException(422, "POSTCONDITION_FAILED", "Second slide was not created");
        call(second, "setSelectedNodeIds", new Class<?>[]{Set.class}, Set.of(state.model.getRootNode().getID()));
        call(presentations, "selectCurrentElement", new Class<?>[]{int.class}, 0);
        call(slides, "selectCurrentElement", new Class<?>[]{int.class}, 0);
        reconcile(state, "map.updated", List.of("presentation"), List.of(state.model.getRootNode().getID()));
        reconcileView(state);
        return guiState(BridgeSupport.JSON.createObjectNode().put("map_id", mapId));
    }

    private Map<String, Object> presentationState(State state) {
        Object controller = presentationController(state);
        Object mapPresentations = call(controller, "getPresentations", new Class<?>[]{MapModel.class}, state.model);
        Object presentations = publicField(mapPresentations, "presentations");
        Object presentation = call(presentations, "getCurrentElement", new Class<?>[]{});
        Object slides = presentation == null ? null : publicField(presentation, "slides");
        var mode = ((AbstractProxy<?>) state.map).getModeController();
        return map(
                "running", actionEnabled(mode, "StopPresentationAction"),
                "presentation_count", intCall(presentations, "getSize"),
                "presentation_index", intCall(presentations, "getCurrentElementIndex"),
                "slide_count", slides == null ? 0 : intCall(slides, "getSize"),
                "slide_index", slides == null ? -1 : intCall(slides, "getCurrentElementIndex"),
                "can_first", actionEnabled(mode, "ShowFirstSlideAction"),
                "can_previous", actionEnabled(mode, "ShowPreviousSlideAction"),
                "can_next", actionEnabled(mode, "ShowNextSlideAction"),
                "can_last", actionEnabled(mode, "ShowLastSlideAction"));
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private Object presentationController(State state) {
        if (!(state.map instanceof AbstractProxy<?> proxy)) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Presentation controller is unavailable");
        }
        try {
            var mode = proxy.getModeController();
            Class<?> type = Class.forName(
                    "org.freeplane.features.presentations.mindmapmode.PresentationController",
                    true,
                    mode.getClass().getClassLoader());
            Object controller = mode.getExtension((Class) type);
            if (controller == null) throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Presentation controller is unavailable");
            return controller;
        } catch (ClassNotFoundException | LinkageError error) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Presentation controller binding changed");
        }
    }

    private Object publicField(Object target, String name) {
        try {
            return target.getClass().getField(name).get(target);
        } catch (ReflectiveOperationException | RuntimeException error) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Presentation field binding changed: " + name);
        }
    }

    private Object call(Object target, String name, Class<?>[] parameterTypes, Object... arguments) {
        try {
            return target.getClass().getMethod(name, parameterTypes).invoke(target, arguments);
        } catch (ReflectiveOperationException | RuntimeException error) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Presentation method binding changed: " + name);
        }
    }

    private int intCall(Object target, String name) {
        Object value = call(target, name, new Class<?>[]{});
        if (!(value instanceof Integer integer)) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Presentation integer readback changed: " + name);
        }
        return integer;
    }

    private boolean actionEnabled(org.freeplane.features.mode.ModeController mode, String key) {
        var action = mode.getAction(key);
        if (action == null) throw new BridgeException(503, "VERSION_UNSUPPORTED", "Presentation action is unavailable: " + key);
        return action.isEnabled();
    }

    private boolean printPreviewOpen() {
        for (Window window : Window.getWindows()) {
            if (window.isVisible() && window.getClass().getName().equals("org.freeplane.features.print.PreviewDialog")) return true;
        }
        return false;
    }

    private static void awaitExportArtifact(Path destination) {
        long deadline = System.nanoTime() + 30_000_000_000L;
        long lastSize = -1;
        long lastModified = -1;
        int stableSamples = 0;
        while (System.nanoTime() < deadline) {
            try {
                BasicFileAttributes attributes = Files.readAttributes(
                        destination, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
                    throw new BridgeException(422, "POSTCONDITION_FAILED", "Export did not create a regular artifact");
                }
                long size = attributes.size();
                long modified = attributes.lastModifiedTime().toMillis();
                stableSamples = size > 0 && size == lastSize && modified == lastModified ? stableSamples + 1 : 0;
                if (stableSamples >= 5) return;
                lastSize = size;
                lastModified = modified;
            } catch (java.nio.file.NoSuchFileException missing) {
                // Vector exporters finish asynchronously on the qualified build.
            } catch (IOException error) {
                throw new BridgeException(422, "POSTCONDITION_FAILED", "Export artifact could not be read");
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new BridgeException(500, "FREEPLANE_ERROR", "Export artifact wait was interrupted");
            }
        }
        throw new BridgeException(422, "POSTCONDITION_FAILED", "Export did not create a stable non-empty artifact");
    }

    private static Path requireMmPath(JsonNode request, String field, boolean existing) {
        String value = BridgeSupport.requiredText(request, field);
        Path path;
        try { path = Path.of(value); }
        catch (RuntimeException invalid) { throw new BridgeException(400, "PATH_DENIED", "Document path is invalid"); }
        if (!path.isAbsolute() || !path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".mm")) {
            throw new BridgeException(400, "PATH_DENIED", "Document path must be an absolute .mm path");
        }
        return existing ? requireExistingMmPath(path) : requireOutputPath(path);
    }

    private static Path requireExistingMmPath(Path path) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
                throw new BridgeException(400, "PATH_DENIED", "Document source must be a regular non-symlink file");
            }
            return path.toRealPath();
        } catch (IOException error) {
            throw new BridgeException(400, "PATH_DENIED", "Document source is unavailable");
        }
    }

    private static Path requireOutputPath(Path path) {
        try {
            Path parent = path.getParent();
            if (parent == null) throw new BridgeException(400, "PATH_DENIED", "Document destination has no parent");
            Path canonical = parent.toRealPath().resolve(path.getFileName());
            if (!Files.isDirectory(parent.toRealPath(), LinkOption.NOFOLLOW_LINKS)) {
                throw new BridgeException(400, "PATH_DENIED", "Document destination parent is not a directory");
            }
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                BasicFileAttributes attributes = Files.readAttributes(canonical, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
                    throw new BridgeException(400, "PATH_DENIED", "Document destination must be a regular non-symlink file");
                }
            }
            return canonical;
        } catch (IOException error) {
            throw new BridgeException(400, "PATH_DENIED", "Document destination is unavailable");
        }
    }

    private static Path requireExportPath(JsonNode request, String format) {
        Path path;
        try { path = Path.of(BridgeSupport.requiredText(request, "destination")); }
        catch (RuntimeException invalid) { throw new BridgeException(400, "PATH_DENIED", "Export destination is invalid"); }
        if (!path.isAbsolute() || !path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith("." + format)) {
            throw new BridgeException(400, "PATH_DENIED", "Export destination extension does not match format_id");
        }
        Path canonical = requireOutputPath(path);
        if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
            throw new BridgeException(409, "FILE_CONFLICT", "Bridge export staging path already exists");
        }
        return canonical;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new BridgeException(422, "POSTCONDITION_FAILED", message);
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

    Map<String, Object> view(JsonNode request) {
        assertMainThread();
        State state = requireState(BridgeSupport.requiredText(request, "map_id"));
        reconcile(state, "snapshot.reconciled", List.of("view_precondition"), List.of());
        reconcileView(state);
        if (activeStateWithoutRefresh() != state) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "View changes require the active Freeplane map");
        }
        long expected = BridgeSupport.requiredNonNegativeLong(request, "expected_view_revision");
        if (state.viewRevision != expected) {
            throw new BridgeException(409, "SELECTION_CONFLICT", "Map view revision changed", map(
                    "expected_view_revision", expected,
                    "actual_view_revision", state.viewRevision));
        }
        String action = BridgeSupport.requiredText(request, "action");
        long before = state.viewRevision;
        if (action.equals("apply_filter")) {
            String value = BridgeSupport.requiredText(request, "value");
            if (value.length() > 512) throw new BridgeException(413, "LIMIT_EXCEEDED", "filter value exceeds 512 characters");
            boolean caseSensitive = request.path("case_sensitive").asBoolean(false);
            boolean showAncestors = request.path("show_ancestors").asBoolean(true);
            boolean showDescendants = request.path("show_descendants").asBoolean(false);
            String needle = caseSensitive ? value : value.toLowerCase(Locale.ROOT);
            NodeCondition condition = node -> {
                String text = node.getText();
                return (caseSensitive ? text : text.toLowerCase(Locale.ROOT)).contains(needle);
            };
            state.map.setFilter(showAncestors, showDescendants, condition);
        } else if (action.equals("clear_filter")) {
            state.map.setFilter((NodeCondition) null);
        } else {
            throw new BridgeException(400, "VALIDATION_ERROR", "Unsupported view action: " + action);
        }
        reconcileView(state);
        if (state.viewRevision == before) {
            state.viewSignature = viewSignature(state);
            state.viewRevision++;
            appendEvent(state, "view.filter", sourceFor(state), List.of(), List.of("filter"), transactionId);
        }

        int total = 0;
        int visible = 0;
        Deque<Node> queue = new ArrayDeque<>();
        queue.add(state.map.getRoot());
        while (!queue.isEmpty()) {
            Node node = queue.removeFirst();
            if (++total > MAX_NODES) throw new BridgeException(413, "LIMIT_EXCEEDED", "map exceeds 10000 nodes");
            if (node.isVisible()) visible++;
            queue.addAll(node.getChildren());
        }
        FilterController filterController = FilterController.getCurrentFilterController();
        if (filterController == null) {
            throw new BridgeException(503, "CAPABILITY_UNVERIFIED", "Native filter controller is unavailable");
        }
        return map(
                "map_id", state.mapId,
                "action", action,
                "content_revision", state.contentRevision,
                "view_revision", state.viewRevision,
                "filter_active", filterController.isFilterActive(),
                "visible_node_count", visible,
                "total_node_count", total);
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
        var geometry = node.getGeometry();
        var cloud = node.getCloud();
        var bookmark = node.getBookmark();
        var reminder = node.getReminder();
        var remindAt = reminder.getRemindAt();
        String rawText = node.getText();
        Object formula = rawText.startsWith("=")
                ? map("expression", rawText, "displayed", node.getDisplayedText())
                : null;
        List<String> contentCloneIds = node.getNodesSharingContent().stream().map(Node::getId).sorted().toList();
        List<String> subtreeCloneIds = node.getNodesSharingContentAndSubtree().stream().map(Node::getId).sorted().toList();
        NodeModel model = nodeModelOf(node);
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
                "text", rawText,
                "details", node.getDetailsText(),
                "note", node.getNoteText(),
                "attributes", attributes,
                "tags", List.copyOf(tags),
                "icons", List.copyOf(icons),
                "links", links,
                "style", map(
                        "name", style.getName(),
                        "background_color", style.getBackgroundColorCode(),
                        "text_color", style.getTextColorCode(),
                        "bold", style.getFont().isBold(),
                        "italic", style.getFont().isItalic(),
                        "font_size", style.getFont().getSize(),
                        "node_shape", String.valueOf(geometry.getShape())),
                "layout", map(
                        "orientation", String.valueOf(node.getLayoutOrientation()),
                        "child_nodes", String.valueOf(node.getChildNodesLayout()),
                        "side_at_root", String.valueOf(node.getSideAtRoot()),
                        "free", node.isFree(),
                        "horizontal_shift", node.getHorizontalShift(),
                        "vertical_shift", node.getVerticalShift(),
                        "minimal_distance_between_children", node.getMinimalDistanceBetweenChildren(),
                        "base_distance_to_children", node.getBaseDistanceToChildrenAsLength().toBaseUnitsRounded()),
                "cloud", map(
                        "enabled", cloud.getEnabled(),
                        "shape", cloud.getShape(),
                        "color", cloud.getColorCode()),
                "bookmark", bookmark == null ? null : map(
                        "name", bookmark.getName(),
                        "type", bookmark.getType().name()),
                "reminder", remindAt == null ? null : map(
                        "at", remindAt.toInstant().toString(),
                        "period_unit", reminder.getPeriodUnit(),
                        "period", reminder.getPeriod(),
                        "script_present", reminder.getScript() != null && !reminder.getScript().isBlank()),
                "formula", formula,
                "clones", map(
                        "content_peer_count", node.getCountNodesSharingContent(),
                        "subtree_peer_count", node.getCountNodesSharingContentAndSubtree(),
                        "content_peer_node_ids", contentCloneIds,
                        "subtree_peer_node_ids", subtreeCloneIds),
                "summary", map(
                        "summary_node", SummaryNode.isSummaryNode(model),
                        "first_group_node", SummaryNode.isFirstGroupNode(model),
                        "always_unfolded", AlwaysUnfoldedNode.isAlwaysUnfolded(model)),
                "timestamps", map(
                        "created", created == null ? null : created.toInstant().toString(),
                        "modified", modified == null ? null : modified.toInstant().toString()),
                "encryption", null,
                "folded", node.isFolded(),
                "connectors", connectors,
                "children", children);
    }

    private static NodeModel nodeModelOf(Node node) {
        if (!(node instanceof AbstractProxy<?> proxy) || !(proxy.getDelegate() instanceof NodeModel model)) {
            throw new BridgeException(503, "VERSION_UNSUPPORTED", "Freeplane node proxy is incompatible with the qualified build");
        }
        return model;
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

    Map<String, Object> qualificationLayout(String mapId, List<String> nodeIds) {
        assertMainThread();
        State state = requireState(mapId);
        List<Map<String, Object>> bounds = new ArrayList<>();
        for (String nodeId : nodeIds) {
            Node node = requireNode(state, nodeId);
            NodeView view = nodeModelOf(node).getViewers().stream()
                    .filter(NodeView.class::isInstance)
                    .map(NodeView.class::cast)
                    .filter(NodeView::isShowing)
                    .findFirst()
                    .orElseThrow(() -> new BridgeException(503, "CAPABILITY_UNVERIFIED", "Visible node bounds are unavailable"));
            Rectangle rectangle = SwingUtilities.convertRectangle(
                    view,
                    new Rectangle(0, 0, view.getWidth(), view.getHeight()),
                    view.getMap());
            bounds.add(map(
                    "node_id", nodeId,
                    "x", rectangle.x,
                    "y", rectangle.y,
                    "width", rectangle.width,
                    "height", rectangle.height));
        }
        return map("map_id", mapId, "bounds", bounds);
    }

    private void reconcileView(State state) {
        String signature = viewSignature(state);
        if (signature.equals(state.viewSignature)) return;
        state.viewSignature = signature;
        state.viewRevision++;
        appendEvent(state, "view.updated", sourceFor(state), selectedIds(state), List.of("selection", "view_root", "zoom", "filter"), transactionId);
    }

    private String viewSignature(State state) {
        State active = activeStateWithoutRefresh();
        if (active != state) return "inactive";
        StringBuilder value = new StringBuilder("active|");
        for (Node node : controller.getSelecteds()) value.append(node.getId()).append(',');
        Node root = controller.getViewRoot();
        Filter filter = FilterController.getFilter(state.model);
        return value.append('|').append(root == null ? "" : root.getId())
                .append('|').append(controller.getZoom())
                .append('|').append(filter == null ? "none" : filter.hashCode())
                .toString();
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
