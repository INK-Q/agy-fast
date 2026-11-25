import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isExplicitAbsoluteOrHomePath(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return true;
  }
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\[^\\]/.test(trimmed);
  }
  return path.posix.isAbsolute(trimmed);
}

function expandHomeIfNeeded(
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const driveHome =
      platform === "win32" && env.HOMEDRIVE && env.HOMEPATH
        ? `${env.HOMEDRIVE}${env.HOMEPATH}`
        : "";
    const home =
      (platform === "win32"
        ? env.USERPROFILE || driveHome || env.HOME
        : env.HOME || env.USERPROFILE) || os.homedir();
    return trimmed === "~" ? home : path.join(home, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function extractLineRangeSpecPath(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim();
  const m = /^(.+):\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.exec(trimmed);
  return m?.[1]?.trim() ?? null;
}

function parseArrayOrJsonString(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface InferredTarget {
  target: string;
  kind: "dir" | "file" | "auto";
}

export function inferCwdFromAllAbsoluteToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidateTargets: InferredTarget[] = [];

  if (toolName === "quick_outline") {
    const list = parseArrayOrJsonString(args.paths);
    if (!list || list.length === 0) return null;
    for (const item of list) {
      if (!isExplicitAbsoluteOrHomePath(item, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(item, env, platform), kind: "file" });
    }
  } else if (toolName === "read_slices") {
    const hasOutlines = args.outlines !== undefined;
    const hasSlices = args.slices !== undefined;
    const hasLineRanges = args.lineRanges !== undefined;
    const outlines = hasOutlines ? parseArrayOrJsonString(args.outlines) : [];
    const slices = hasSlices ? parseArrayOrJsonString(args.slices) : [];
    const lineRanges = hasLineRanges ? parseArrayOrJsonString(args.lineRanges) : [];
    if (!outlines || !slices || !lineRanges) return null;
    if (outlines.length === 0 && slices.length === 0 && lineRanges.length === 0) {
      return null;
    }
    for (const p of outlines) {
      if (!isExplicitAbsoluteOrHomePath(p, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(p, env, platform), kind: "file" });
    }
    for (const s of slices) {
      if (typeof s === "string") {
        const sp = extractLineRangeSpecPath(s);
        if (!sp || !isExplicitAbsoluteOrHomePath(sp, platform)) return null;
        candidateTargets.push({ target: expandHomeIfNeeded(sp, env, platform), kind: "file" });
      } else if (s && typeof s === "object" && !Array.isArray(s)) {
        const sp = (s as { path?: unknown }).path;
        if (!isExplicitAbsoluteOrHomePath(sp, platform)) return null;
        candidateTargets.push({ target: expandHomeIfNeeded(sp, env, platform), kind: "file" });
      } else {
        return null;
      }
    }
    for (const lr of lineRanges) {
      const sp = extractLineRangeSpecPath(lr);
      if (!sp || !isExplicitAbsoluteOrHomePath(sp, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(sp, env, platform), kind: "file" });
    }
  } else if (toolName === "apply_edits") {
    if (args.verify !== undefined && args.verify !== null && args.verify !== "") {
      if (typeof args.verify === "string") return null;
      if (typeof args.verify === "object" && !Array.isArray(args.verify)) {
        const vCwd = (args.verify as { cwd?: unknown }).cwd;
        if (!isExplicitAbsoluteOrHomePath(vCwd, platform)) return null;
        candidateTargets.push({ target: expandHomeIfNeeded(vCwd, env, platform), kind: "dir" });
      } else {
        return null;
      }
    }
    const rawEdits = parseArrayOrJsonString(args.edits);
    if (!rawEdits || rawEdits.length === 0) return null;
    for (const item of rawEdits) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const p = (item as { path?: unknown }).path;
      if (!isExplicitAbsoluteOrHomePath(p, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(p, env, platform), kind: "file" });
    }
  } else if (toolName === "batch_search") {
    const queries = parseArrayOrJsonString(args.queries);
    if (!queries || queries.length === 0) return null;
    for (const q of queries) {
      if (!q || typeof q !== "object" || Array.isArray(q)) return null;
      const p = (q as { path?: unknown }).path;
      if (!isExplicitAbsoluteOrHomePath(p, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(p, env, platform), kind: "auto" });
    }
  } else if (toolName === "run_checks") {
    const commands = parseArrayOrJsonString(args.commands);
    if (!commands || commands.length === 0) return null;
    for (const c of commands) {
      if (!c || typeof c !== "object" || Array.isArray(c)) return null;
      const cmdCwd = (c as { cwd?: unknown }).cwd;
      if (!isExplicitAbsoluteOrHomePath(cmdCwd, platform)) return null;
      candidateTargets.push({ target: expandHomeIfNeeded(cmdCwd, env, platform), kind: "dir" });
    }
  }

  if (candidateTargets.length === 0) return null;
  const first = candidateTargets[0]!;
  if (first.kind === "dir") {
    return first.target;
  }
  if (first.kind === "auto") {
    try {
      if (fs.statSync(first.target).isDirectory()) return first.target;
    } catch {
      // Fall back to dirname below
    }
  }
  return path.dirname(first.target);
}
