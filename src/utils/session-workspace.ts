import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHomeOrSystemRoot } from "./snapshot.js";

export interface SessionWorkspacePayload {
  cwd?: unknown;
  workspacePaths?: unknown;
  workspace_paths?: unknown;
  workspaceRoots?: unknown;
  workspace_roots?: unknown;
}

export function isFullAbsolutePath(dirPath: string): boolean {
  return process.platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(dirPath)
    : path.isAbsolute(dirPath);
}

export function canonicalizeDirSync(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  try {
    return typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isSameOrSubdir(candidate: string, root: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  const normCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normRoot = caseInsensitive ? root.toLowerCase() : root;
  const rel = path.relative(normRoot, normCandidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export function isInstalledPluginPath(dirPath: string): boolean {
  const posix = dirPath.replace(/\\/g, "/");
  return /(?:^|\/)(?:\.gemini\/(?:config\/|antigravity[^/]*\/)?plugins|\.agents\/plugins)\/[^/]+(?:\/|$)/i.test(
    posix,
  );
}

export interface DetectPluginInstallOptions {
  allowLinkedDevCheckout?: boolean;
}

/**
 * Returns the matched installed plugin root when `candidateDir` resolves inside
 * this plugin's installed runtime directory (`PLUGIN_ROOT`, `AGY_PLUGIN_ROOT`,
 * or a non-source-repo `scriptPluginRoot`), or `null` otherwise.
 *
 * By default (`allowLinkedDevCheckout = false`), any `candidateDir` resolving inside
 * `PLUGIN_ROOT` / `AGY_PLUGIN_ROOT` is treated strictly as the plugin install dir so
 * `mcp-server` never writes into a `--link` checkout when POSIX `process.cwd()` resolves
 * the symlink to `<dev-repo>`. Read-only `SessionStart` (`resolveSessionWorkspaceDir`,
 * where `payload.cwd` carries the host's logical path) opts into
 * `allowLinkedDevCheckout: true` so opening `<dev-repo>` directly still snapshots cleanly.
 */
export function detectPluginInstallDir(
  candidateDir: string,
  scriptPluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DetectPluginInstallOptions = {},
): string | null {
  const allowLinkedDevCheckout = options.allowLinkedDevCheckout === true;
  const resolvedCandidate = path.resolve(candidateDir);
  const canonCandidate = canonicalizeDirSync(resolvedCandidate);

  for (const envRoot of [env.PLUGIN_ROOT, env.AGY_PLUGIN_ROOT]) {
    if (typeof envRoot === "string" && envRoot.trim()) {
      const trimmedEnvRoot = envRoot.trim();
      const resolvedEnvRoot = path.resolve(trimmedEnvRoot);
      const canonEnvRoot = canonicalizeDirSync(resolvedEnvRoot);
      if (isSameOrSubdir(canonCandidate, canonEnvRoot)) {
        if (!allowLinkedDevCheckout) {
          return trimmedEnvRoot;
        }
        const isDevCheckout = fs.existsSync(
          path.join(canonEnvRoot, "src", "mcp-server.ts"),
        );
        if (
          !isDevCheckout ||
          isSameOrSubdir(resolvedCandidate, resolvedEnvRoot) ||
          isInstalledPluginPath(resolvedCandidate)
        ) {
          return trimmedEnvRoot;
        }
      }
    }
  }

  const resolvedScriptRoot = path.resolve(scriptPluginRoot);
  const canonScriptRoot = canonicalizeDirSync(resolvedScriptRoot);
  if (isSameOrSubdir(canonCandidate, canonScriptRoot)) {
    const isRuntimeOnlyInstall =
      fs.existsSync(path.join(canonScriptRoot, "plugin.json")) &&
      !fs.existsSync(path.join(canonScriptRoot, "src", "mcp-server.ts"));
    if (
      isInstalledPluginPath(resolvedCandidate) ||
      isInstalledPluginPath(canonScriptRoot) ||
      isRuntimeOnlyInstall
    ) {
      return scriptPluginRoot;
    }
  }

  return null;
}

export function isPluginInstallDir(
  candidateDir: string,
  scriptPluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DetectPluginInstallOptions = {},
): boolean {
  return detectPluginInstallDir(candidateDir, scriptPluginRoot, env, options) !== null;
}

function resolveHomeFromEnv(env: NodeJS.ProcessEnv): string {
  const driveHome =
    process.platform === "win32" &&
    typeof env.HOMEDRIVE === "string" &&
    typeof env.HOMEPATH === "string" &&
    env.HOMEDRIVE.trim() &&
    env.HOMEPATH.trim()
      ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}`
      : "";
  for (const cand of [env.HOME, env.USERPROFILE, driveHome]) {
    if (typeof cand === "string" && cand.trim() && isFullAbsolutePath(cand.trim())) {
      return path.resolve(cand.trim());
    }
  }
  try {
    const osHome = os.homedir();
    if (osHome && isFullAbsolutePath(osHome)) {
      return path.resolve(osHome);
    }
  } catch {
    // Ignore missing OS home directory
  }
  return "";
}

function expandLeadingTilde(rawPath: string, env: NodeJS.ProcessEnv): string {
  if (rawPath === "~") {
    return resolveHomeFromEnv(env) || rawPath;
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    const home = resolveHomeFromEnv(env);
    return home ? path.join(home, rawPath.slice(2)) : rawPath;
  }
  return rawPath;
}

function isExistingDirectorySync(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function collectExplicitWorkspaceCandidates(payload: SessionWorkspacePayload): string[] {
  const lists = [
    payload.workspacePaths,
    payload.workspace_paths,
    payload.workspaceRoots,
    payload.workspace_roots,
  ];
  const out: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && item.trim()) {
        out.push(item.trim());
      }
    }
  }
  return out;
}

/**
 * Resolves the target workspace directory for `SessionStart`:
 * - Validates explicit `workspacePaths` / `workspaceRoots` entries (expanding `~`,
 *   rejecting relative or non-existent/non-directory entries, and preferring non-home
 *   roots when multiple roots are listed while still allowing a single `[targetDir]`
 *   smoke check from `scripts/install.mjs doctor`).
 * - Rejects `agy-fast`'s own installed plugin directory in `payload.cwd` (while
 *   preserving `<dev-repo>` dogfooding under `install.mjs install --link`).
 * - Prefers valid explicit workspace roots over an unrelated or `$HOME` `cwd`, while
 *   keeping `cwd` when it points to a subpackage inside a non-home workspace root.
 */
export async function resolveSessionWorkspaceDir(
  payload: SessionWorkspacePayload,
  scriptPluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const rawExplicit = collectExplicitWorkspaceCandidates(payload);
  const validExplicitRoots: string[] = [];
  for (const item of rawExplicit) {
    const expanded = expandLeadingTilde(item, env);
    if (!isFullAbsolutePath(expanded)) continue;
    const resolved = path.resolve(expanded);
    if (isExistingDirectorySync(resolved)) {
      validExplicitRoots.push(resolved);
    }
  }

  let primaryWorkspace = "";
  let primaryIsHomeOrRoot = false;
  let nonHomeExplicitRoots: string[] = [];
  if (validExplicitRoots.length > 0) {
    const homeFlags = await Promise.all(
      validExplicitRoots.map((root) => isHomeOrSystemRoot(root, undefined, env)),
    );
    nonHomeExplicitRoots = validExplicitRoots.filter((_, idx) => !homeFlags[idx]);
    if (nonHomeExplicitRoots.length > 0) {
      primaryWorkspace = nonHomeExplicitRoots[0]!;
      primaryIsHomeOrRoot = false;
    } else {
      primaryWorkspace = validExplicitRoots[0]!;
      primaryIsHomeOrRoot = true;
    }
  }

  const rawCwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  const expandedCwd = rawCwd ? expandLeadingTilde(rawCwd, env) : "";
  const resolvedCwd =
    expandedCwd && isFullAbsolutePath(expandedCwd)
      ? path.resolve(expandedCwd)
      : "";
  const validCwd =
    resolvedCwd &&
    isExistingDirectorySync(resolvedCwd) &&
    !isPluginInstallDir(resolvedCwd, scriptPluginRoot, env, {
      allowLinkedDevCheckout: true,
    })
      ? resolvedCwd
      : "";

  if (primaryWorkspace && validCwd) {
    if (await isHomeOrSystemRoot(validCwd, undefined, env)) {
      return primaryWorkspace;
    }
    if (primaryIsHomeOrRoot) {
      return validCwd;
    }
    const canonCwd = canonicalizeDirSync(validCwd);
    for (const root of nonHomeExplicitRoots) {
      if (isSameOrSubdir(canonCwd, canonicalizeDirSync(root))) {
        return validCwd;
      }
    }
    return primaryWorkspace;
  }

  return primaryWorkspace || validCwd;
}
