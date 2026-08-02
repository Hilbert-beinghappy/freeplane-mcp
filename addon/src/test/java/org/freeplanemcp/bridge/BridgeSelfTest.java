package org.freeplanemcp.bridge;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Map;
import java.util.Set;

public final class BridgeSelfTest {
    public static void main(String[] args) throws Exception {
        assert BridgeSupport.bearerMatches("Bearer secret", "secret");
        assert !BridgeSupport.bearerMatches("Bearer wrong", "secret");
        assert !BridgeSupport.bearerMatches(null, "secret");
        assert BridgeSupport.validRequestId("qualify:1-abc");
        assert !BridgeSupport.validRequestId("contains space");
        assert BridgeSupport.isJsonContentType("application/json; charset=utf-8");
        assert !BridgeSupport.isJsonContentType("text/plain");
        var integers = BridgeSupport.JSON.readTree("{\"revision\":2,\"limit\":5}");
        assert BridgeSupport.requiredNonNegativeLong(integers, "revision") == 2;
        assert BridgeSupport.optionalInt(integers, "limit", 10, 1, 100) == 5;
        try {
            BridgeSupport.requiredNonNegativeLong(
                    BridgeSupport.JSON.readTree("{\"revision\":1.5}"), "revision");
            throw new AssertionError("fractional revision was accepted");
        } catch (BridgeSupport.BridgeException expected) {
            assert expected.status == 400;
        }

        String firstHash = BridgeSupport.canonicalHash(BridgeSupport.JSON.readTree("{\"b\":2,\"a\":1}"));
        String secondHash = BridgeSupport.canonicalHash(BridgeSupport.JSON.readTree("{\"a\":1,\"b\":2}"));
        assert firstHash.equals(secondHash);
        assert TransactionEngine.validArithmeticFormula("=(365 + 365) / 2");
        assert TransactionEngine.validArithmeticFormula("=1.5%2");
        assert !TransactionEngine.validArithmeticFormula("=node.text");
        assert !TransactionEngine.validArithmeticFormula("=(1 + 2");
        assert !TransactionEngine.validArithmeticFormula("=1++2");
        assert TransactionEngine.richTextEquals("", null);
        assert TransactionEngine.richTextEquals("", "");
        assert TransactionEngine.richTextEquals("details", "details");
        assert !TransactionEngine.richTextEquals("details", null);

        String cursor = BridgeSupport.cursor("instance", 42);
        assert BridgeSupport.decodeCursor(cursor, "instance") == 42;
        try {
            BridgeSupport.decodeCursor("x".repeat(513), "instance");
            throw new AssertionError("oversized cursor was accepted");
        } catch (BridgeSupport.BridgeException expected) {
            assert expected.status == 400;
        }
        try {
            BridgeSupport.decodeCursor(cursor, "other");
            throw new AssertionError("instance mismatch was accepted");
        } catch (BridgeSupport.BridgeException expected) {
            assert expected.category.equals("CURSOR_INSTANCE_MISMATCH");
        }

        try {
            BridgeSupport.readBounded(
                    new ByteArrayInputStream("1234".getBytes(StandardCharsets.UTF_8)), 3);
            throw new AssertionError("oversized body was accepted");
        } catch (BridgeSupport.BridgeException expected) {
            assert expected.status == 413;
        }

        Path temporary = Files.createTempDirectory("freeplane-mcp-discovery-test-");
        Path discovery = temporary.resolve("runtime").resolve("bridge.json");
        try {
            BridgeSupport.writeAtomicJson(discovery, Map.of("schema_version", 1, "token", "test-only"));
            assert BridgeSupport.JSON.readTree(Files.readAllBytes(discovery)).path("schema_version").intValue() == 1;
            assert Files.getPosixFilePermissions(discovery).equals(Set.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE));
            assert Files.getPosixFilePermissions(discovery.getParent()).equals(Set.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE));
        } finally {
            try (var paths = Files.walk(temporary)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (Exception error) {
                        throw new RuntimeException(error);
                    }
                });
            }
        }

        System.out.println("BridgeSelfTest: pass");
    }
}
