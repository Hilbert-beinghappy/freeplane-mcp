package org.freeplanemcp.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.freeplane.api.Controller;

import javax.swing.SwingUtilities;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.freeplanemcp.bridge.BridgeSupport.BridgeException;
import static org.freeplanemcp.bridge.BridgeSupport.map;

public final class FreeplaneBridge implements AutoCloseable {
    private static final String ADDON_VERSION = "0.5.0";
    private static final String QUALIFIED_BUILD_FINGERPRINT = "ff6dab76e60acfb0666ee8ac90dcf2df5bbb1975c2d99eab59ca3f08dcda1822";
    private static final int REQUESTS_PER_SECOND = 240;
    private static FreeplaneBridge instance;

    private final Controller controller;
    private final boolean qualification;
    private final String runtimeOverride;
    private final String configuredFingerprint;
    private final long processId;
    private final String instanceId = UUID.randomUUID().toString();
    private final String token;
    private final Instant createdAt = Instant.now();
    private final Path discoveryPath;
    private final MapRegistry registry;
    private final TransactionEngine transactions;
    private final HttpServer server;
    private final ThreadPoolExecutor workers;
    private final Semaphore concurrency = new Semaphore(4);
    private long rateSecond;
    private int rateCount;
    private volatile boolean closed;

    private FreeplaneBridge(
            Controller controller,
            String runtimeOverride,
            boolean qualification,
            String configuredFingerprint) throws Exception {
        this.controller = controller;
        this.runtimeOverride = runtimeOverride;
        this.qualification = qualification;
        this.configuredFingerprint = configuredFingerprint;
        this.processId = currentPid();
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        token = BridgeSupport.randomToken(secret);
        discoveryPath = runtimeDirectory().resolve("bridge.json");
        registry = new MapRegistry(controller, instanceId);
        transactions = new TransactionEngine(controller, registry, qualification);

        server = HttpServer.create(new InetSocketAddress(
                InetAddress.getByAddress(new byte[]{127, 0, 0, 1}), 0), 16);
        ThreadFactory daemonFactory = runnable -> {
            Thread thread = new Thread(runnable, "freeplane-mcp-http");
            thread.setDaemon(true);
            return thread;
        };
        workers = new ThreadPoolExecutor(
                2,
                4,
                30,
                TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(32),
                daemonFactory,
                new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(workers);
        server.createContext("/", this::handle);

        onMain(() -> {
            registry.start();
            return null;
        });
        server.start();
        writeDiscovery();
    }

    public static synchronized Map<String, Object> start(Controller controller) {
        return start(controller, null, false, QUALIFIED_BUILD_FINGERPRINT);
    }

    public static synchronized Map<String, Object> start(
            Controller controller,
            String runtimeDirectory,
            boolean qualificationMode,
            String buildFingerprint) {
        if (instance != null && !instance.closed) return instance.publicStatus();
        try {
            instance = new FreeplaneBridge(
                    controller,
                    runtimeDirectory,
                    qualificationMode,
                    buildFingerprint);
            return instance.publicStatus();
        } catch (Exception error) {
            throw new IllegalStateException("Freeplane MCP bridge failed to start: " + safeMessage(error), error);
        }
    }

    private Map<String, Object> publicStatus() {
        return map(
                "bridge_instance_id", instanceId,
                "host", "127.0.0.1",
                "port", server.getAddress().getPort(),
                "addon_version", ADDON_VERSION);
    }

    private Path runtimeDirectory() {
        if (runtimeOverride != null && !runtimeOverride.isBlank()) {
            return Path.of(runtimeOverride).toAbsolutePath().normalize();
        }
        return Path.of(
                System.getProperty("user.home"),
                "Library",
                "Application Support",
                "Freeplane-MCP",
                "runtime");
    }

    private void writeDiscovery() throws IOException {
        Instant processStart = createdAt;
        String fingerprint = configuredFingerprint;
        if (fingerprint == null || !fingerprint.matches("[a-f0-9]{64}")) {
            fingerprint = QUALIFIED_BUILD_FINGERPRINT;
        }
        BridgeSupport.writeAtomicJson(discoveryPath, map(
                "schema_version", 1,
                "bridge_instance_id", instanceId,
                "pid", processId,
                "process_start_time", processStart.toString(),
                "host", "127.0.0.1",
                "port", server.getAddress().getPort(),
                "token", token,
                "freeplane_version", controller.getFreeplaneVersion().toString(),
                "freeplane_build_fingerprint", fingerprint,
                "addon_version", ADDON_VERSION,
                "created_at", createdAt.toString(),
                "expires_at", createdAt.plus(365, ChronoUnit.DAYS).toString()));
    }

    private void handle(HttpExchange exchange) throws IOException {
        String requestId = exchange.getRequestHeaders().getFirst("X-Request-Id");
        if (!BridgeSupport.validRequestId(requestId)) {
            send(exchange, 400, requestId, null,
                    new BridgeException(400, "VALIDATION_ERROR", "X-Request-Id is required and must be 1-128 safe characters"));
            exchange.close();
            return;
        }
        if (!BridgeSupport.bearerMatches(exchange.getRequestHeaders().getFirst("Authorization"), token)) {
            send(exchange, 401, requestId, null,
                    new BridgeException(401, "AUTH_FAILED", "Bearer token is missing or invalid"));
            exchange.close();
            return;
        }
        if (exchange.getRequestHeaders().containsKey("Origin")) {
            send(exchange, 403, requestId, null,
                    new BridgeException(403, "POLICY_DENIED", "Browser Origin requests are rejected"));
            exchange.close();
            return;
        }
        if (!allowRate()) {
            send(exchange, 429, requestId, null,
                    new BridgeException(429, "LIMIT_EXCEEDED", "Bridge request rate exceeded"));
            exchange.close();
            return;
        }
        if (!concurrency.tryAcquire()) {
            send(exchange, 429, requestId, null,
                    new BridgeException(429, "LIMIT_EXCEEDED", "Bridge concurrency limit exceeded"));
            exchange.close();
            return;
        }

        try {
            URI uri = exchange.getRequestURI();
            String path = uri.getPath();
            String method = exchange.getRequestMethod();
            JsonNode body = null;
            if (method.equals("POST")) {
                if (!BridgeSupport.isJsonContentType(exchange.getRequestHeaders().getFirst("Content-Type"))) {
                    throw new BridgeException(415, "VALIDATION_ERROR", "POST requests require Content-Type: application/json");
                }
                body = BridgeSupport.parseObject(exchange.getRequestBody(), requestBodyLimit(exchange.getRequestHeaders()));
            }

            Object result = route(method, path, body);
            send(exchange, 200, requestId, result, null);
        } catch (BridgeException error) {
            send(exchange, error.status, requestId, null, error);
        } catch (TimeoutException error) {
            send(exchange, 504, requestId, null,
                    new BridgeException(504, "TIMEOUT", "Freeplane main-thread request timed out"));
        } catch (Exception error) {
            send(exchange, 500, requestId, null,
                    new BridgeException(500, "FREEPLANE_ERROR", safeMessage(error)));
        } finally {
            concurrency.release();
            exchange.close();
        }
    }

    private Object route(String method, String path, JsonNode body) throws Exception {
        if (method.equals("GET") && path.equals("/v1/health")) {
            return onMain(() -> map(
                    "bridge_instance_id", instanceId,
                    "status", "ok",
                    "host", "127.0.0.1",
                    "port", server.getAddress().getPort(),
                    "pid", processId,
                    "freeplane_version", controller.getFreeplaneVersion().toString(),
                    "addon_version", ADDON_VERSION,
                    "qualification_mode", qualification,
                    "registry", registry.healthData()));
        }
        if (method.equals("GET") && path.equals("/v1/capabilities")) {
            return map("capabilities", List.of(
                    map("capability_id", "bridge.loopback", "status", "runtime_available", "write_exposed_to_mcp", false),
                    map("capability_id", "map.read", "status", "runtime_available", "write_exposed_to_mcp", false),
                    map("capability_id", "map.changes", "status", "runtime_available", "write_exposed_to_mcp", false),
                    map("capability_id", "transaction.atomic_undo_spike", "status", "qualification_required", "write_exposed_to_mcp", false)));
        }
        if (method.equals("GET") && path.equals("/v1/maps")) {
            return onMain(() -> map("maps", registry.listMaps()));
        }
        if (method.equals("POST") && path.equals("/v1/read")) {
            return onMain(() -> registry.read(body));
        }
        if (method.equals("POST") && path.equals("/v1/search")) {
            return onMain(() -> registry.search(body));
        }
        if (method.equals("POST") && path.equals("/v1/changes")) {
            return onMain(() -> registry.changes(body));
        }
        if (method.equals("POST") && path.equals("/v1/view")) {
            return onMain(() -> registry.withEventContext("mcp", null, () -> registry.view(body)));
        }
        if (method.equals("POST") && path.equals("/v1/document")) {
            return onMain(() -> registry.withEventContext("mcp", null, () -> registry.document(body)));
        }
        if (method.equals("POST") && path.equals("/v1/export")) {
            return onMain(() -> registry.exportMap(body));
        }
        if (method.equals("POST") && path.equals("/v1/gui-state")) {
            return onMain(() -> registry.guiState(body));
        }
        if (method.equals("POST") && path.equals("/v1/transactions/plan")) {
            return onMain(() -> transactions.plan(body));
        }
        if (method.equals("POST") && path.equals("/v1/transactions/commit")) {
            return await(onMain(() -> transactions.commit(body)));
        }
        if (method.equals("POST") && path.equals("/v1/history")) {
            return await(onMain(() -> transactions.history(body)));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/history")) {
            return onMain(() -> transactions.qualificationHistory(body));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/ui-ready")) {
            if (!qualification) {
                throw new BridgeException(403, "POLICY_DENIED", "UI qualification is disabled outside an isolated run");
            }
            String marker = BridgeSupport.requiredText(body, "marker");
            if (marker.length() > 512) {
                throw new BridgeException(413, "LIMIT_EXCEEDED", "UI marker exceeds 512 characters");
            }
            return onMain(() -> {
                registry.expectUiEdit(marker, System.currentTimeMillis());
                return map("ready", true);
            });
        }
        if (method.equals("POST") && path.equals("/v1/qualification/silent-text")) {
            requireQualification();
            String mapId = BridgeSupport.requiredText(body, "map_id");
            String value = BridgeSupport.requiredText(body, "value");
            if (value.length() > 512) throw new BridgeException(413, "LIMIT_EXCEEDED", "Qualification text is too long");
            return onMain(() -> registry.qualificationSilentText(mapId, value));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/fill-events")) {
            requireQualification();
            String mapId = BridgeSupport.requiredText(body, "map_id");
            int count = BridgeSupport.optionalInt(body, "count", 1, 1, 60_000);
            return onMain(() -> registry.qualificationFillEvents(mapId, count));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/layout")) {
            requireQualification();
            String mapId = BridgeSupport.requiredText(body, "map_id");
            var nodeIds = BridgeSupport.requiredArray(body, "node_ids");
            if (nodeIds.isEmpty() || nodeIds.size() > 100) {
                throw new BridgeException(400, "VALIDATION_ERROR", "node_ids must contain between 1 and 100 entries");
            }
            List<String> ids = new java.util.ArrayList<>();
            for (JsonNode nodeId : nodeIds) {
                if (!nodeId.isTextual()) throw new BridgeException(400, "VALIDATION_ERROR", "node_ids must contain strings");
                ids.add(nodeId.textValue());
            }
            return onMain(() -> registry.qualificationLayout(mapId, ids));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/presentation")) {
            requireQualification();
            String mapId = BridgeSupport.requiredText(body, "map_id");
            return onMain(() -> registry.qualificationPresentation(mapId));
        }
        if (method.equals("POST") && path.equals("/v1/qualification/restart")) {
            requireQualification();
            scheduleRestart();
            return map("restart_scheduled", true, "previous_instance_id", instanceId);
        }
        if (path.startsWith("/v1/")) {
            throw new BridgeException(404, "CAPABILITY_UNAVAILABLE", "Bridge endpoint is unavailable");
        }
        throw new BridgeException(404, "CAPABILITY_UNAVAILABLE", "Unknown bridge path");
    }

    private void requireQualification() {
        if (!qualification) {
            throw new BridgeException(403, "POLICY_DENIED", "Qualification endpoint is disabled outside an isolated run");
        }
    }

    private void scheduleRestart() {
        Thread restart = new Thread(() -> {
            try {
                Thread.sleep(150);
                synchronized (FreeplaneBridge.class) {
                    if (instance != this || closed) return;
                    Controller restartController = controller;
                    String restartRuntime = runtimeOverride;
                    boolean restartQualification = qualification;
                    String restartFingerprint = configuredFingerprint;
                    close(false);
                    instance = new FreeplaneBridge(
                            restartController,
                            restartRuntime,
                            restartQualification,
                            restartFingerprint);
                }
            } catch (Throwable error) {
                System.err.println("Freeplane MCP qualification restart failed: " + safeMessage(error));
                error.printStackTrace(System.err);
                synchronized (FreeplaneBridge.class) {
                    if (instance == this) instance = null;
                }
            }
        }, "freeplane-mcp-qualification-restart");
        restart.setDaemon(true);
        restart.start();
    }

    private <T> T onMain(Callable<T> action) throws Exception {
        if (SwingUtilities.isEventDispatchThread()) return action.call();
        return await(controller.getMainThreadExecutorService().submit(action));
    }

    private <T> T await(Future<T> future) throws Exception {
        try {
            return future.get(15, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException wrapped) {
            Throwable cause = wrapped.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error error) throw error;
            throw wrapped;
        } catch (TimeoutException timeout) {
            throw timeout;
        }
    }

    private synchronized boolean allowRate() {
        long second = System.currentTimeMillis() / 1_000;
        if (second != rateSecond) {
            rateSecond = second;
            rateCount = 0;
        }
        return ++rateCount <= REQUESTS_PER_SECOND;
    }

    private int requestBodyLimit(Headers headers) {
        String override = headers.getFirst("X-Freeplane-MCP-Qualification-Body-Limit");
        if (!qualification || override == null) return BridgeSupport.MAX_BODY_BYTES;
        try {
            int value = Integer.parseInt(override);
            if (value < 1 || value > BridgeSupport.MAX_BODY_BYTES) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException invalid) {
            throw new BridgeException(400, "VALIDATION_ERROR", "Qualification body limit is invalid");
        }
    }

    private void send(
            HttpExchange exchange,
            int status,
            String requestId,
            Object data,
            BridgeException error) throws IOException {
        Map<String, Object> envelope = map(
                "schema_version", 1,
                "ok", error == null,
                "request_id", requestId,
                "bridge_instance_id", instanceId,
                "data", data,
                "error", error == null ? null : map(
                        "category", error.category,
                        "message", error.getMessage(),
                        "details", error.details));
        byte[] bytes = BridgeSupport.jsonBytes(envelope);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        if (BridgeSupport.validRequestId(requestId)) exchange.getResponseHeaders().set("X-Request-Id", requestId);
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    @Override
    public synchronized void close() {
        close(true);
    }

    private synchronized void close(boolean terminateWorkers) {
        if (closed) return;
        closed = true;
        try {
            onMain(() -> {
                registry.close();
                return null;
            });
        } catch (Exception ignored) {
            // The process is shutting down; discovery is removed below either way.
        }
        server.stop(0);
        // ponytail: qualification restart leaves two old daemon workers; the isolated process
        // exits after the gate. Normal shutdown still terminates its pool immediately.
        if (terminateWorkers) workers.shutdownNow();
        try {
            if (Files.exists(discoveryPath)) {
                JsonNode discovery = BridgeSupport.JSON.readTree(Files.readAllBytes(discoveryPath));
                if (instanceId.equals(discovery.path("bridge_instance_id").asText())) {
                    Files.deleteIfExists(discoveryPath);
                }
            }
        } catch (IOException ignored) {
            // Stale discovery is rejected by PID, instance, expiry, and health checks.
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static long currentPid() {
        try {
            String runtimeName = ManagementFactory.getRuntimeMXBean().getName();
            int separator = runtimeName.indexOf('@');
            return Long.parseLong(separator < 0 ? runtimeName : runtimeName.substring(0, separator));
        } catch (RuntimeException unavailable) {
            return -1;
        }
    }
}
