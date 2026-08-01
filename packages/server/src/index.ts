import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createFreeplaneMcpServer, loadProbeResult } from "./mcp.js";

try {
  const result = await loadProbeResult();
  serveStdio(() => createFreeplaneMcpServer(result), {
    legacy: "serve",
    onerror: (error) => process.stderr.write(`${error.message}\n`),
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Freeplane MCP failed to start"}\n`);
  process.exitCode = 1;
}
