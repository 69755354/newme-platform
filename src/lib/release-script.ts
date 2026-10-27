import { statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a helper script that ships inside the running release.
 *
 * Three routes executed their helper by absolute path:
 *     /home/ubuntu/newme-platform/scripts/cos-presign.py    (cos/download-url)
 *     /home/ubuntu/newme-platform/scripts/cos-presign.py    (contracts/[id]/upload-url)
 *     /home/ubuntu/newme-platform/scripts/parse-ad-spend.py (dashboard/ads-roi/import)
 *
 * /home/ubuntu/newme-platform is explicitly NOT a release target. Deploys build
 * an immutable tree at /opt/newme/releases/<sha>, chmod it a-w, and move the
 * `current` symlink (scripts/deploy-immutable.sh). Nothing in that protocol
 * touches /home/ubuntu/newme-platform, and scripts/guard-prod-build.sh exists
 * precisely to stop builds happening there. So the deployed application was
 * signing COS URLs and parsing ad spend with code from a checkout that no deploy
 * updates, no rollback reverts, and no release manifest covers: the app could be
 * rolled back three releases while the presigner stayed at HEAD.
 *
 * process.cwd() is the release root (the systemd unit's WorkingDirectory), so a
 * script resolved through here is the copy from the same immutable tree as the
 * route calling it, and it rolls back with it.
 *
 * Fails closed. A missing script means a broken release, which is not a reason
 * to reach outside it — the fallback path is what created this problem.
 *
 * REVISED 2026-08-11. The first version of this function had two holes, both
 * found by tests/unit/l0-auth-hardening.test.mjs:
 *
 *  1. FAIL-OPEN ON EMPTY INPUT. `path.resolve(root, "")` is `root`, and the check
 *     was `existsSync(resolved)` — so "" and "." resolved to the release root
 *     itself and were returned as a valid script. A caller would then have handed
 *     a directory to spawn(). Containment is now tested with path.relative and
 *     the target must be a regular file.
 *  2. PREFIX CONTAINMENT. `resolved.startsWith(root)` treats
 *     /opt/newme/releases/abc123 as inside /opt/newme/releases/abc — a different
 *     release. path.relative() is the correct test.
 */
export function resolveReleaseScript(relativePath: string): string | null {
  if (typeof relativePath !== "string" || relativePath.trim() === "") return null;

  // Reject anything that could climb out of the release tree. Split on both
  // separators rather than a substring search, so a legitimate filename that
  // merely contains ".." is not rejected while "a/../b" still is.
  if (path.isAbsolute(relativePath)) return null;
  if (relativePath.split(/[\\/]+/).includes("..")) return null;

  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized.startsWith("scripts/")) return null;
  const scriptRelativePath = normalized.slice("scripts/".length);
  if (!scriptRelativePath) return null;

  // Keep the dynamic suffix statically scoped to the shipped scripts directory.
  // Besides tightening the runtime contract, this prevents the production
  // tracer from treating every file in the release as a possible dependency.
  const scriptsRoot = path.join(process.cwd(), "scripts");
  const resolved = path.join(scriptsRoot, scriptRelativePath);

  const relative = path.relative(scriptsRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  return resolved;
}
