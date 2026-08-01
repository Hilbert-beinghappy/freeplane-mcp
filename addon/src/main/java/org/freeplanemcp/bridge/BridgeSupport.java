package org.freeplanemcp.bridge;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import org.freeplane.api.Connector;
import org.freeplane.api.Node;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class BridgeSupport {
    static final ObjectMapper JSON = new ObjectMapper();
    static final int MAX_BODY_BYTES = 10 * 1024 * 1024;
    private static final Set<PosixFilePermission> DIRECTORY_PERMISSIONS = EnumSet.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
            PosixFilePermission.OWNER_EXECUTE);
    private static final Set<PosixFilePermission> FILE_PERMISSIONS = EnumSet.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE);

    private BridgeSupport() {
    }

    static JsonNode parseObject(InputStream stream, int maximum) throws IOException {
        byte[] bytes = readBounded(stream, maximum);
        if (bytes.length == 0) {
            throw new BridgeException(400, "VALIDATION_ERROR", "JSON request body is required");
        }
        JsonNode node;
        try {
            node = JSON.readTree(bytes);
        } catch (JsonProcessingException error) {
            throw new BridgeException(400, "VALIDATION_ERROR", "Malformed JSON request body");
        }
        if (!node.isObject()) {
            throw new BridgeException(400, "VALIDATION_ERROR", "JSON request body must be an object");
        }
        return node;
    }

    static byte[] readBounded(InputStream stream, int maximum) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maximum, 8192));
        byte[] buffer = new byte[8192];
        int total = 0;
        for (int count; (count = stream.read(buffer)) != -1; ) {
            total += count;
            if (total > maximum) {
                throw new BridgeException(413, "LIMIT_EXCEEDED", "Request body exceeds 10 MiB");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    static byte[] jsonBytes(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Could not encode bridge JSON", error);
        }
    }

    static String sha256(byte[] value) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static String canonicalHash(JsonNode value) {
        return sha256(jsonBytes(canonicalize(value)));
    }

    static Map<String, Object> connectorData(Node source, Connector connector) {
        return map(
                "source_id", source.getId(),
                "target_id", connector.getTarget().getId(),
                "shape", connector.getShape(),
                "color", connector.getColorCode(),
                "width", connector.getWidth(),
                "start_arrow", connector.hasStartArrow(),
                "end_arrow", connector.hasEndArrow(),
                "source_label", connector.getSourceLabel(),
                "middle_label", connector.getMiddleLabel(),
                "target_label", connector.getTargetLabel());
    }

    static String connectorId(Node source, Connector connector) {
        return "fpconn:" + canonicalHash(JSON.valueToTree(connectorData(source, connector)));
    }

    static JsonNode canonicalize(JsonNode value) {
        if (value.isObject()) {
            ObjectNode sorted = JSON.createObjectNode();
            List<Map.Entry<String, JsonNode>> entries = new ArrayList<>();
            value.fields().forEachRemaining(entries::add);
            entries.sort(Comparator.comparing(Map.Entry::getKey));
            for (Map.Entry<String, JsonNode> entry : entries) {
                sorted.set(entry.getKey(), canonicalize(entry.getValue()));
            }
            return sorted;
        }
        if (value.isArray()) {
            ArrayNode array = JSON.createArrayNode();
            value.forEach(item -> array.add(canonicalize(item)));
            return array;
        }
        return value.deepCopy();
    }

    static void writeAtomicJson(Path target, Object value) throws IOException {
        Path directory = target.getParent();
        Files.createDirectories(directory);
        setPermissions(directory, DIRECTORY_PERMISSIONS);
        Path temporary = Files.createTempFile(directory, ".bridge-", ".tmp");
        try {
            setPermissions(temporary, FILE_PERMISSIONS);
            byte[] bytes = jsonBytes(value);
            try (FileChannel channel = FileChannel.open(
                    temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                channel.write(ByteBuffer.wrap(bytes));
                channel.force(true);
            }
            try {
                Files.move(temporary, target,
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                throw new IOException("Atomic discovery replacement is unavailable", unsupported);
            }
            setPermissions(target, FILE_PERMISSIONS);
            fsyncDirectory(directory);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void setPermissions(Path path, Set<PosixFilePermission> permissions) throws IOException {
        try {
            Files.setPosixFilePermissions(path, permissions);
        } catch (SecurityException sandboxed) {
            // Freeplane's script sandbox denies chmod even when file writes are explicitly allowed.
            // The installer/qualification harness pre-creates the runtime directory as 0700; a
            // same-directory createTempFile remains 0600 under the supported macOS environment.
        } catch (UnsupportedOperationException unsupported) {
            throw new IOException("POSIX permissions are required for bridge discovery", unsupported);
        }
    }

    private static void fsyncDirectory(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    static boolean bearerMatches(String authorization, String token) {
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            return false;
        }
        byte[] supplied = authorization.substring("Bearer ".length()).getBytes(StandardCharsets.UTF_8);
        byte[] expected = token.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(supplied, expected);
    }

    static boolean validRequestId(String requestId) {
        return requestId != null
                && requestId.length() <= 128
                && requestId.matches("[A-Za-z0-9._:-]+");
    }

    static boolean isJsonContentType(String contentType) {
        return contentType != null
                && contentType.split(";", 2)[0].trim().equalsIgnoreCase("application/json");
    }

    static String requiredText(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isTextual() || value.textValue().isBlank()) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a non-empty string");
        }
        return value.textValue();
    }

    static long requiredNonNegativeLong(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < 0) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be a non-negative integer");
        }
        return value.longValue();
    }

    static int optionalInt(JsonNode object, String field, int fallback, int minimum, int maximum) {
        JsonNode value = object.get(field);
        if (value == null) return fallback;
        if (!value.isIntegralNumber() || !value.canConvertToInt()) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be an integer");
        }
        int result = value.intValue();
        if (result < minimum || result > maximum) {
            throw new BridgeException(400, "VALIDATION_ERROR",
                    field + " must be between " + minimum + " and " + maximum);
        }
        return result;
    }

    static ArrayNode requiredArray(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (!(value instanceof ArrayNode array)) {
            throw new BridgeException(400, "VALIDATION_ERROR", field + " must be an array");
        }
        return array;
    }

    static String cursor(String instanceId, long sequence) {
        String raw = instanceId + "\n" + sequence;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    static long decodeCursor(String cursor, String instanceId) {
        if (cursor.length() > 512) {
            throw new BridgeException(400, "VALIDATION_ERROR", "cursor is malformed");
        }
        final String raw;
        try {
            raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException invalid) {
            throw new BridgeException(400, "VALIDATION_ERROR", "cursor is malformed");
        }
        int separator = raw.lastIndexOf('\n');
        if (separator <= 0) {
            throw new BridgeException(400, "VALIDATION_ERROR", "cursor is malformed");
        }
        if (!raw.substring(0, separator).equals(instanceId)) {
            throw new BridgeException(409, "CURSOR_INSTANCE_MISMATCH", "cursor belongs to another bridge instance");
        }
        try {
            long sequence = Long.parseLong(raw.substring(separator + 1));
            if (sequence < 0) throw new NumberFormatException();
            return sequence;
        } catch (NumberFormatException invalid) {
            throw new BridgeException(400, "VALIDATION_ERROR", "cursor is malformed");
        }
    }

    static Map<String, Object> map(Object... values) {
        if (values.length % 2 != 0) throw new IllegalArgumentException("map needs key/value pairs");
        int entries = values.length / 2;
        Map<String, Object> result = new LinkedHashMap<>(Math.max(1, (entries * 4 + 2) / 3));
        for (int index = 0; index < values.length; index += 2) {
            result.put((String) values[index], values[index + 1]);
        }
        return result;
    }

    static String randomToken(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static final class BridgeException extends RuntimeException {
        final int status;
        final String category;
        final Map<String, Object> details;

        BridgeException(int status, String category, String message) {
            this(status, category, message, Map.of());
        }

        BridgeException(int status, String category, String message, Map<String, Object> details) {
            super(message);
            this.status = status;
            this.category = category;
            this.details = details;
        }
    }
}
