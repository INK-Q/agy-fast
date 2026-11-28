import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceUtf8Bytes } from "./output-filter.js";

export type SpillToolName = "run_checks" | "apply_edits" | "batch_search";

export const SPILL_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SPILL_MAX_FILES = 20;
export const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
export const SPILL_DEFAULT_MIN_BODY_CHARS = 400;
export const SPILL_DEFAULT_MIN_BODY_BYTES = 400;
export const SPILL_HARD_MIN_CONTENT_BYTES = 120;
export const SPILL_MAX_FOOTER_SHARE = 0.35;

/** Strictly linear O(N) filename matcher for rotation (skips unrelated files). */
export const SPILL_FILENAME_RE = /^spill-\d+-[a-z0-9_-]+-[0-9a-f]+\.txt$/;

const DISABLED_VALUES = new Set(["0", "off", "false", "no"]);

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  if (platform === "win32") {
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(env)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return undefined;
}

export function isSpillEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const raw = getEnvValue(env, "AGY_FAST_SPILL", platform)?.trim().toLowerCase();
  if (!raw) return true;
  return !DISABLED_VALUES.has(raw);
}

function getPrivateHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") {
    const userProfile = getEnvValue(env, "USERPROFILE", platform)?.trim();
    if (userProfile) return userProfile;
    const drive = getEnvValue(env, "HOMEDRIVE", platform);
    const homePath = getEnvValue(env, "HOMEPATH", platform);
    const driveHome = drive && homePath ? `${drive}${homePath}`.trim() : "";
    if (driveHome) return driveHome;
    const home = getEnvValue(env, "HOME", platform)?.trim();
    if (home) return home;
  } else {
    const home = env.HOME?.trim() || env.USERPROFILE?.trim();
    if (home) return home;
  }
  try {
    const fallback = os.homedir()?.trim();
    return fallback || null;
  } catch {
    return null;
  }
}

interface ResolvedSpillPaths {
  cacheDir: string;
  spillDir: string;
  /** Directories we own that MUST be real directories (never symlinks) owned by current user. */
  strictDirs: string[];
}

function hasUnsafeControlChars(p: string): boolean {
  return p.includes("\n") || p.includes("\r") || p.includes("\0");
}

function resolveSpillPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedSpillPaths | null {
  const customCache = getEnvValue(env, "AGY_FAST_CACHE_DIR", platform)?.trim();
  if (customCache) {
    if (hasUnsafeControlChars(customCache)) return null;
    const cacheDir = path.resolve(customCache);
    const spillDir = path.join(cacheDir, "spills");
    return { cacheDir, spillDir, strictDirs: [cacheDir, spillDir] };
  }

  const geminiHome = getEnvValue(env, "GEMINI_HOME", platform)?.trim();
  if (geminiHome) {
    if (hasUnsafeControlChars(geminiHome)) return null;
    const base = path.resolve(geminiHome);
    const cacheParent = path.join(base, "cache");
    const cacheDir = path.join(cacheParent, "agy-fast");
    const spillDir = path.join(cacheDir, "spills");
    return { cacheDir, spillDir, strictDirs: [base, cacheParent, cacheDir, spillDir] };
  }

  const home = getPrivateHomeDir(env, platform);
  if (!home || hasUnsafeControlChars(home)) return null;
  const base = path.join(path.resolve(home), ".gemini");
  const cacheParent = path.join(base, "cache");
  const cacheDir = path.join(cacheParent, "agy-fast");
  const spillDir = path.join(cacheDir, "spills");
  return { cacheDir, spillDir, strictDirs: [cacheParent, cacheDir, spillDir] };
}

export function resolveSpillDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveSpillPaths(env, platform)?.spillDir ?? null;
}

export function formatSpillByteSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatSpillFooter(filePath: string, byteLength: number): string {
  return `\n... [Full output saved: ${filePath} (${formatSpillByteSize(byteLength)}); inspect with read_file(StartLine, EndLine) or batch_search]`;
}

export interface CappedSpillPayload {
  payload: string;
  bytes: number;
  originalBytes: number;
  capped: boolean;
}

export function capSpillContent(
  rawContent: string,
  maxBytes = SPILL_MAX_FILE_BYTES,
): CappedSpillPayload {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : SPILL_MAX_FILE_BYTES;
  const originalBytes = Buffer.byteLength(rawContent, "utf8");
  if (originalBytes <= limit) {
    return { payload: rawContent, bytes: originalBytes, originalBytes, capped: false };
  }
  const capNote = `\n... [spill capped at 2 MiB; original ${originalBytes} bytes]\n`;
  const noteBytes = Buffer.byteLength(capNote, "utf8");
  if (limit <= noteBytes) {
    const sliced = sliceUtf8Bytes(rawContent, limit);
    return {
      payload: sliced,
      bytes: Buffer.byteLength(sliced, "utf8"),
      originalBytes,
      capped: true,
    };
  }
  const sliced = sliceUtf8Bytes(rawContent, limit - noteBytes);
  const payload = `${sliced}${capNote}`;
  return {
    payload,
    bytes: Buffer.byteLength(payload, "utf8"),
    originalBytes,
    capped: true,
  };
}

function isOwnedByCurrentUser(st: fs.Stats, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  if (typeof process.getuid !== "function") return true;
  return st.uid === process.getuid();
}

function verifyRealDir(
  dirPath: string,
  platform: NodeJS.Platform,
  checkOwner: boolean,
): boolean {
  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (checkOwner && !isOwnedByCurrentUser(st, platform)) return false;
    return true;
  } catch {
    return false;
  }
}

function ensureSafeSpillDir(
  paths: ResolvedSpillPaths,
  platform: NodeJS.Platform,
): string | null {
  const { cacheDir, spillDir, strictDirs } = paths;
  const strictSet = new Set(strictDirs);

  // 1. Reject immediately if any existing owned component is a symlink, non-dir, or wrong uid.
  for (const dir of strictDirs) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      if (!isOwnedByCurrentUser(st, platform)) return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") return null;
    }
  }

  // 2. Collect missing directory chain from spillDir upward so we create step-by-step with 0o700.
  const missing: string[] = [];
  let cur = spillDir;
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (strictSet.has(cur)) {
        if (st.isSymbolicLink() || !st.isDirectory() || !isOwnedByCurrentUser(st, platform)) {
          return null;
        }
      } else {
        // Ancestor outside our cache sub-tree (e.g. ~/.gemini or temp root) must resolve to a directory.
        const resolvedStat = fs.statSync(cur);
        if (!resolvedStat.isDirectory()) return null;
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") return null;
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  for (let i = missing.length - 1; i >= 0; i--) {
    const dir = missing[i]!;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") return null;
    }
    if (!verifyRealDir(dir, platform, true)) return null;
    if (platform !== "win32") {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        return null;
      }
    }
  }

  // 3. Re-verify all owned components and enforce 0o700 on spillDir against permissive umasks.
  for (const dir of strictDirs) {
    if (!verifyRealDir(dir, platform, true)) return null;
  }
  if (platform !== "win32") {
    try {
      fs.chmodSync(spillDir, 0o700);
    } catch {
      return null;
    }
  }

  // 4. TOCTOU realpath check: ensure spillDir truly lives directly under cacheDir.
  try {
    const realCache = fs.realpathSync(cacheDir);
    const realSpill = fs.realpathSync(spillDir);
    if (path.dirname(realSpill) !== realCache || path.basename(realSpill) !== "spills") {
      return null;
    }
    if (!verifyRealDir(realSpill, platform, true)) return null;
    return realSpill;
  } catch {
    return null;
  }
}

export function rotateSpillFiles(
  spillDir: string,
  keepFileName: string,
  nowMs: number = Date.now(),
  maxFiles: number = SPILL_MAX_FILES,
  ttlMs: number = SPILL_TTL_MS,
): void {
  try {
    const names = fs.readdirSync(spillDir);
    const cutoffMs = nowMs - ttlMs;
    const survivors: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];

    for (const name of names) {
      if (!SPILL_FILENAME_RE.test(name)) continue;
      const fullPath = path.join(spillDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;

      if (name !== keepFileName && st.mtimeMs < cutoffMs) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Best-effort cleanup; ignore races / permission errors
        }
        continue;
      }
      survivors.push({ name, fullPath, mtimeMs: st.mtimeMs });
    }

    const limit = Math.max(1, Math.trunc(maxFiles));
    if (survivors.length <= limit) return;

    // Sort newest-first, pinning the just-written file at index 0 and breaking same-ms ties deterministically by filename.
    survivors.sort((a, b) => {
      if (a.name === keepFileName && b.name !== keepFileName) return -1;
      if (b.name === keepFileName && a.name !== keepFileName) return 1;
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.name > a.name ? 1 : b.name < a.name ? -1 : 0;
    });

    for (let i = limit; i < survivors.length; i++) {
      const target = survivors[i]!;
      if (target.name === keepFileName) continue;
      try {
        fs.unlinkSync(target.fullPath);
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Fail-open: rotation errors never affect tool output
  }
}

function buildSpillFileName(
  tool: SpillToolName,
  timestampMs: number,
  randomHex: string,
): string {
  const safeTs = Math.max(0, Math.trunc(timestampMs));
  return `spill-${safeTs}-${tool}-${randomHex}.txt`;
}

function writeExclusiveSpillFile(
  realSpillDir: string,
  tool: SpillToolName,
  timestampMs: number,
  initialRandomHex: string,
  payload: string,
  platform: NodeJS.Platform,
): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const randHex =
      attempt === 0 ? initialRandomHex : crypto.randomBytes(6).toString("hex");
    const fileName = buildSpillFileName(tool, timestampMs, randHex);
    const realTarget = path.join(realSpillDir, fileName);
    let fd: number | undefined;
    try {
      fd = fs.openSync(realTarget, "wx", 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      if (platform !== "win32") {
        fs.fchmodSync(fd, 0o600);
      }
      fs.closeSync(fd);
      fd = undefined;
      return fileName;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
        fd = undefined;
        try {
          fs.unlinkSync(realTarget);
        } catch {
          // ignore partial file cleanup error
        }
      }
      if (code === "EEXIST") continue;
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }
  return null;
}

export interface ReserveSpillOptions {
  tool: SpillToolName;
  rawContent: string;
  totalMaxChars: number;
  totalMaxBytes: number;
  availableBodyChars: number;
  availableBodyBytes: number;
  minBodyChars?: number;
  minBodyBytes?: number;
  maxFooterShare?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nowMs?: number;
}

export interface SpillReservation {
  footerChars: number;
  footerBytes: number;
  /** Writes the spill file to disk, rotates old files, and returns the 1-line footer or null on fail-open. */
  commit(): string | null;
}

/**
 * Phase 1 of tool-boundary spilling: validates kill switch, resolves private
 * cache dir, caps payload <= 2 MiB, and enforces small-budget safety BEFORE
 * creating any directory or writing any file.
 */
export function reserveSpill(options: ReserveSpillOptions): SpillReservation | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!isSpillEnabled(env, platform)) return null;

  const paths = resolveSpillPaths(env, platform);
  if (!paths) return null;

  const capped = capSpillContent(options.rawContent, SPILL_MAX_FILE_BYTES);
  const nowMs =
    options.nowMs !== undefined && Number.isFinite(options.nowMs)
      ? Math.max(0, Math.trunc(options.nowMs))
      : Date.now();
  const initialRandomHex = crypto.randomBytes(6).toString("hex");
  const candidateName = buildSpillFileName(options.tool, nowMs, initialRandomHex);
  const candidatePath = path.join(paths.spillDir, candidateName);
  const candidateFooter = formatSpillFooter(candidatePath, capped.bytes);
  const footerChars = candidateFooter.length;
  const footerBytes = Buffer.byteLength(candidateFooter, "utf8");

  const minBodyChars = Math.max(
    SPILL_HARD_MIN_CONTENT_BYTES,
    options.minBodyChars ?? SPILL_DEFAULT_MIN_BODY_CHARS,
  );
  const minBodyBytes = Math.max(
    SPILL_HARD_MIN_CONTENT_BYTES,
    options.minBodyBytes ?? SPILL_DEFAULT_MIN_BODY_BYTES,
  );
  const maxFooterShare = options.maxFooterShare ?? SPILL_MAX_FOOTER_SHARE;

  if (
    options.availableBodyChars - footerChars < minBodyChars ||
    options.availableBodyBytes - footerBytes < minBodyBytes ||
    footerChars > Math.floor(options.totalMaxChars * maxFooterShare) ||
    footerBytes > Math.floor(options.totalMaxBytes * maxFooterShare)
  ) {
    return null;
  }

  let committed = false;
  return {
    footerChars,
    footerBytes,
    commit(): string | null {
      if (committed) return null;
      committed = true;
      try {
        const realSpillDir = ensureSafeSpillDir(paths, platform);
        if (!realSpillDir) return null;

        const writtenName = writeExclusiveSpillFile(
          realSpillDir,
          options.tool,
          nowMs,
          initialRandomHex,
          capped.payload,
          platform,
        );
        if (!writtenName) return null;

        rotateSpillFiles(realSpillDir, writtenName, nowMs);
        return formatSpillFooter(path.join(paths.spillDir, writtenName), capped.bytes);
      } catch {
        return null;
      }
    },
  };
}

export interface WriteSpillOptions {
  tool: SpillToolName;
  rawContent: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nowMs?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  ttlMs?: number;
}

export interface WriteSpillResult {
  filePath: string;
  fileName: string;
  bytes: number;
  originalBytes: number;
  capped: boolean;
  footer: string;
}

/** Direct spill helper (also convenient for unit tests); fail-open returns null. */
export function writeSpillFile(options: WriteSpillOptions): WriteSpillResult | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!isSpillEnabled(env, platform)) return null;

  const paths = resolveSpillPaths(env, platform);
  if (!paths) return null;

  try {
    const realSpillDir = ensureSafeSpillDir(paths, platform);
    if (!realSpillDir) return null;

    const capped = capSpillContent(options.rawContent, options.maxFileBytes ?? SPILL_MAX_FILE_BYTES);
    const nowMs =
      options.nowMs !== undefined && Number.isFinite(options.nowMs)
        ? Math.max(0, Math.trunc(options.nowMs))
        : Date.now();
    const initialRandomHex = crypto.randomBytes(6).toString("hex");
    const writtenName = writeExclusiveSpillFile(
      realSpillDir,
      options.tool,
      nowMs,
      initialRandomHex,
      capped.payload,
      platform,
    );
    if (!writtenName) return null;

    rotateSpillFiles(
      realSpillDir,
      writtenName,
      nowMs,
      options.maxFiles ?? SPILL_MAX_FILES,
      options.ttlMs ?? SPILL_TTL_MS,
    );
    const filePath = path.join(paths.spillDir, writtenName);
    return {
      filePath,
      fileName: writtenName,
      bytes: capped.bytes,
      originalBytes: capped.originalBytes,
      capped: capped.capped,
      footer: formatSpillFooter(filePath, capped.bytes),
    };
  } catch {
    return null;
  }
}
