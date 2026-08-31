// WorkspaceSourceResolver (spec 003 §B4 storage boundary; P2-E1/P2-E3) — the ONLY path by which
// evidence provenance ever reads bytes out of an Agent's workspace. Every read is scoped to the
// single workspace root the injected resolver names for that agentId. Escapes via `..`,
// absolute paths, or symlinks, and secret-shaped filenames, are rejected before any file content
// is touched — evidence must never be able to quote a credential file.

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Prefixed } from "../shared/hash.js";

export interface WorkspacePathResolver {
  resolveWorkspacePath(agentId: string): string;
}

export type SafeResolveResult =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: "unsafe_path" };

export type WorkspaceReadResult =
  | { ok: true; content: string; currentHash: string }
  | { ok: false; reason: "not_found" | "unsafe_path" | "unreadable" };

// Filenames evidence must never be able to quote, regardless of how safe the path otherwise is.
const SECRET_FILENAME_PATTERNS: readonly RegExp[] = [/^\.env/i, /\.pem$/i, /^id_rsa/i];
const EXCLUDED_PATH_SEGMENTS = new Set([".git", ".codex", ".walnut", "node_modules"]);
export const MAX_WORKSPACE_EVIDENCE_BYTES = 1_048_576;

function looksLikeSecretFilename(relativePath: string): boolean {
  const base = path.basename(relativePath);
  return SECRET_FILENAME_PATTERNS.some((pattern) => pattern.test(base));
}

function hasDotDotSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => segment === "..");
}

function hasExcludedSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

export function isWorkspaceEvidencePathAllowed(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    !hasDotDotSegment(relativePath) &&
    !hasExcludedSegment(relativePath) &&
    !looksLikeSecretFilename(relativePath)
  );
}

export class WorkspaceSourceResolver {
  constructor(private readonly deps: WorkspacePathResolver) {}

  async safeResolve(agentId: string, relativePath: string): Promise<SafeResolveResult> {
    if (!isWorkspaceEvidencePathAllowed(relativePath)) {
      return { ok: false, reason: "unsafe_path" };
    }

    const workspace = this.deps.resolveWorkspacePath(agentId);
    const resolvedPath = path.resolve(workspace, relativePath);
    if (resolvedPath !== workspace && !resolvedPath.startsWith(workspace + path.sep)) {
      return { ok: false, reason: "unsafe_path" };
    }

    // Symlink escape check: only meaningful once the target exists. A not-yet-existing path
    // cannot have escaped through a symlink; `read` reports "not_found" for that case instead.
    try {
      const realResolved = await realpath(resolvedPath);
      const realWorkspace = await realpath(workspace).catch(() => workspace);
      if (realResolved !== realWorkspace && !realResolved.startsWith(realWorkspace + path.sep)) {
        return { ok: false, reason: "unsafe_path" };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, reason: "unsafe_path" };
      }
    }

    return { ok: true, absolutePath: resolvedPath };
  }

  async read(agentId: string, relativePath: string): Promise<WorkspaceReadResult> {
    const safe = await this.safeResolve(agentId, relativePath);
    if (!safe.ok) return safe;

    try {
      const metadata = await stat(safe.absolutePath);
      if (!metadata.isFile() || metadata.size > MAX_WORKSPACE_EVIDENCE_BYTES) {
        return { ok: false, reason: "unsafe_path" };
      }
      const buffer = await readFile(safe.absolutePath);
      if (looksBinary(buffer)) return { ok: false, reason: "unsafe_path" };
      return {
        ok: true,
        content: buffer.toString("utf8"),
        currentHash: sha256Prefixed(buffer),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      return { ok: false, reason: "unreadable" };
    }
  }
}
