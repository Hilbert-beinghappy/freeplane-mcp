import { execFile as execFileCallback } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function findFreeplaneApp(explicit) {
  const candidates = [explicit, process.env.FREEPLANE_HOME, process.env.FREEPLANE_APP]
    .filter((value) => typeof value === "string" && value.length > 0);
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFile("/usr/bin/mdfind", [
        "kMDItemCFBundleIdentifier == 'org.freeplane.launcher'",
      ]);
      candidates.push(...stdout.split("\n").filter((entry) => entry.endsWith(".app")));
    } catch {
      // Spotlight is optional; explicit paths and the user Applications directory remain.
    }
  }
  candidates.push(path.join(homedir(), "Applications", "Freeplane.app"));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      // Try the next discovered candidate.
    }
  }
  throw new Error("Freeplane.app was not found; set FREEPLANE_HOME or FREEPLANE_APP to its absolute path");
}
