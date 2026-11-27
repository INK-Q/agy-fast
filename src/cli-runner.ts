import { promises as fs } from "node:fs";
import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import {
  runBatchSearch,
  type BatchSearchInput,
  type SearchQuery,
} from "./tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";
import { resolvePath } from "./utils/fs-utils.js";

export type CliCanonicalTool =
  | "batch_search"
  | "quick_outline"
  | "read_slices"
  | "apply_edits"
  | "run_checks";

export interface CliIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  cwd?: string;
}

const MAX_CLI_STDIN_BYTES = 2 * 1024 * 1024;
const IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS = 500;

const TOOL_ALIASES: Record<string, CliCanonicalTool> = {
  search: "batch_search",
  batch_search: "batch_search",
  outline: "quick_outline",
  quick_outline: "quick_outline",
  slice: "read_slices",
  slices: "read_slices",
  read_slices: "read_slices",
  edit: "apply_edits",
  apply_edits: "apply_edits",
  check: "run_checks",
  checks: "run_checks",
  run_checks: "run_checks",
};

export function resolveCliToolAlias(name: string | undefined): CliCanonicalTool | null {
  if (!name) return null;
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? null;
}

export function formatCliUsage(): string {
  return [
    "agy-fast direct CLI mode (for Swarm workers, scripts, and non-MCP environments)",
    "",
    "Usage:",
    "  node <plugin>/dist/mcp-server.mjs --cli <command> [options] [args...]",
    "",
    "Commands (aliases):",
    "  outline | quick_outline <file...> [--cwd <dir>] [--max-chars <N>]",
    "  slice   | read_slices   <path:start-end,...> [--outline <file>] [--cwd <dir>]",
    "  search  | batch_search  [--text <p>] [--regex <p>] [--glob <p>] [--fuzzy <p>] [--git <cmd>]",
    "                          [--pattern <p>] [--type text|regex|glob|fuzzy|git]",
    "                          [--path <dir>] [--file-type <t>] [--glob-filter <g>]",
    "                          [--output-mode content|files_with_matches|count] [--sort-by path|mtime]",
    "                          [--context <0..10>] [--max-results <N>] [-i|--ignore-case] [--multiline]",
    "                          (modifiers before a query scope only to that query; trailing modifiers apply to all)",
    "  check   | run_checks    <cmd...> [--compact|--full] [--output-mode compact|full] [--concurrency <N>] [--timeout <sec>]",
    "  edit    | apply_edits   [--from-file <path>] [--best-effort] [--dry-run] [--diff] [--verify <cmd>]",
    "                          [--verify-timeout <sec>] [--max-verify-chars <N>] (JSON via --from-file, --json, or stdin)",
    "",
    "JSON input (works for every command using the exact MCP tool schema):",
    "  --from-file <path>      Read tool arguments JSON from file (avoids shell escaping for multi-line edits)",
    "  --json '<json>'         Pass tool arguments JSON object (or shorthand array) inline",
    "  --stdin                 Read tool arguments JSON from stdin (or pipe/heredoc with no positional args)",
    "  --cwd <dir>             Override working directory (defaults to shell CWD)",
    "  --max-chars <N>         Override output character cap (hard UTF-8 ceiling <= 8800 bytes)",
  ].join("\n");
}

function parseIntFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Expected integer value after ${flag}`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer value after ${flag}: ${raw}`);
  }
  return n;
}

async function readStdinText(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  explicitStdin: boolean,
): Promise<string> {
  if (!explicitStdin && stream.isTTY) {
    return "";
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof (stream as { pause?: () => void }).pause === "function") {
        (stream as { pause: () => void }).pause();
      }
      const maybeUnref = (stream as unknown as { unref?: () => void }).unref;
      if (typeof maybeUnref === "function") {
        maybeUnref.call(stream);
      }
      reject(err);
    };

    const onData = (chunk: Buffer | string) => {
      if (firstByteTimer !== undefined) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_CLI_STDIN_BYTES) {
        fail(new Error(`stdin payload exceeds ${MAX_CLI_STDIN_BYTES} bytes limit`));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (err: Error) => {
      fail(err);
    };

    if (!explicitStdin) {
      firstByteTimer = setTimeout(() => {
        if (totalBytes === 0) {
          if (typeof (stream as { pause?: () => void }).pause === "function") {
            (stream as { pause: () => void }).pause();
          }
          const maybeUnref = (stream as unknown as { unref?: () => void }).unref;
          if (typeof maybeUnref === "function") {
            maybeUnref.call(stream);
          }
          finish("");
        }
      }, IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS);
      firstByteTimer.unref?.();
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (typeof (stream as { resume?: () => void }).resume === "function") {
      (stream as { resume: () => void }).resume();
    }
  });
}

function parseJsonPayload(
  rawText: string,
  tool: CliCanonicalTool,
): Record<string, unknown> {
  const cleaned = rawText.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Invalid JSON input for '${tool}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Array.isArray(parsed)) {
    if (tool === "batch_search") return { queries: parsed };
    if (tool === "apply_edits") return { edits: parsed };
    if (tool === "quick_outline") return { paths: parsed };
    if (tool === "read_slices") {
      if (parsed.every((item) => typeof item === "string")) {
        return { lineRanges: parsed };
      }
      return { slices: parsed };
    }
    if (tool === "run_checks") {
      return {
        commands: parsed.map((item) =>
          typeof item === "string" ? { command: item } : item,
        ),
      };
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>) };
  }
  throw new Error(`JSON input for '${tool}' must be an object (or shorthand array).`);
}

async function readJsonPayloadFromFile(
  rawFilePath: string,
  baseDir: string,
  tool: CliCanonicalTool,
): Promise<Record<string, unknown>> {
  const absPath = resolvePath(rawFilePath, baseDir);
  let st;
  try {
    st = await fs.stat(absPath);
  } catch (err) {
    throw new Error(
      `Cannot read --from-file '${rawFilePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!st.isFile()) {
    throw new Error(`--from-file path is not a regular file: '${rawFilePath}'`);
  }
  if (st.size > MAX_CLI_STDIN_BYTES) {
    throw new Error(
      `--from-file '${rawFilePath}' exceeds ${MAX_CLI_STDIN_BYTES} bytes limit`,
    );
  }
  const raw = (await fs.readFile(absPath, "utf8")).replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new Error(`--from-file '${rawFilePath}' is empty`);
  }
  return parseJsonPayload(raw, tool);
}

interface SearchQueryModifiers {
  path?: string;
  fileType?: string;
  glob?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  sortBy?: "path" | "mtime";
  contextLines?: number;
  maxResults?: number;
  caseSensitive?: boolean;
  multiline?: boolean;
}

function applySearchModifiers(
  q: SearchQuery,
  mods: SearchQueryModifiers,
): SearchQuery {
  return {
    ...q,
    ...(mods.path !== undefined && q.path === undefined ? { path: mods.path } : {}),
    ...(mods.fileType !== undefined && q.fileType === undefined
      ? { fileType: mods.fileType }
      : {}),
    ...(mods.glob !== undefined && q.glob === undefined ? { glob: mods.glob } : {}),
    ...(mods.outputMode !== undefined && q.outputMode === undefined
      ? { outputMode: mods.outputMode }
      : {}),
    ...(mods.sortBy !== undefined && q.sortBy === undefined ? { sortBy: mods.sortBy } : {}),
    ...(mods.contextLines !== undefined && q.contextLines === undefined
      ? { contextLines: mods.contextLines }
      : {}),
    ...(mods.maxResults !== undefined && q.maxResults === undefined
      ? { maxResults: mods.maxResults }
      : {}),
    ...(mods.caseSensitive !== undefined && q.caseSensitive === undefined
      ? { caseSensitive: mods.caseSensitive }
      : {}),
    ...(mods.multiline !== undefined && q.multiline === undefined
      ? { multiline: mods.multiline }
      : {}),
  };
}

const SEARCH_QUERY_TYPES = new Set<SearchQuery["type"]>([
  "text",
  "regex",
  "glob",
  "fuzzy",
  "git",
]);

const VALUE_LONG_FLAGS = new Set([
  "--cwd",
  "--max-chars",
  "--from-file",
  "--json",
  "--text",
  "--regex",
  "--glob",
  "--fuzzy",
  "--git",
  "--pattern",
  "--type",
  "--path",
  "--file-type",
  "--glob-filter",
  "--output-mode",
  "--sort-by",
  "--context",
  "--max-results",
  "--outline",
  "--concurrency",
  "--timeout",
  "--verify",
  "--verify-timeout",
  "--max-verify-chars",
]);

interface ParsedCliOptions {
  showHelp: boolean;
  cwd?: string;
  maxChars?: number;
  fromFile?: string;
  jsonRaw?: string;
  explicitStdin: boolean;
  positionals: string[];
  // search flags
  searchQueries: SearchQuery[];
  implicitTypeQueryIndices: Set<number>;
  trailingSearchType?: SearchQuery["type"];
  trailingSearchMods: SearchQueryModifiers;
  // slice flags
  outlineFiles: string[];
  // check flags
  outputMode?: "compact" | "full";
  concurrency?: number;
  timeoutSec?: number;
  // edit flags
  bestEffort?: boolean;
  dryRun?: boolean;
  diff?: boolean;
  verify?: string;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

function parseToolFlags(tool: CliCanonicalTool, rawArgs: string[]): ParsedCliOptions {
  const opts: ParsedCliOptions = {
    showHelp: false,
    explicitStdin: false,
    positionals: [],
    searchQueries: [],
    implicitTypeQueryIndices: new Set<number>(),
    trailingSearchMods: {},
    outlineFiles: [],
  };
  let pendingMods: SearchQueryModifiers = {};
  let pendingType: SearchQuery["type"] | undefined;
  let dashDashType: SearchQuery["type"] | undefined;
  let dashDashMods: SearchQueryModifiers = {};
  const pushScopedQuery = (base: SearchQuery, explicitType: boolean) => {
    const idx = opts.searchQueries.length;
    opts.searchQueries.push(applySearchModifiers(base, pendingMods));
    if (!explicitType) {
      opts.implicitTypeQueryIndices.add(idx);
    }
    pendingMods = {};
    pendingType = undefined;
  };

  let afterDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const rawArg = rawArgs[i]!;
    if (afterDoubleDash) {
      if (tool === "batch_search") {
        const explicit = dashDashType !== undefined;
        const idx = opts.searchQueries.length;
        opts.searchQueries.push(
          applySearchModifiers({ type: dashDashType ?? "text", pattern: rawArg }, dashDashMods),
        );
        if (!explicit) {
          opts.implicitTypeQueryIndices.add(idx);
        }
      } else {
        opts.positionals.push(rawArg);
      }
      continue;
    }
    if (rawArg === "--") {
      afterDoubleDash = true;
      dashDashType = pendingType;
      dashDashMods = pendingMods;
      pendingType = undefined;
      pendingMods = {};
      continue;
    }

    let arg = rawArg;
    let inlineValue: string | undefined;
    if (rawArg.startsWith("--")) {
      const eqIdx = rawArg.indexOf("=");
      if (eqIdx > 2) {
        const candidateFlag = rawArg.slice(0, eqIdx);
        if (VALUE_LONG_FLAGS.has(candidateFlag)) {
          arg = candidateFlag;
          inlineValue = rawArg.slice(eqIdx + 1);
        }
      }
    }

    const consumeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = rawArgs[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value after ${arg}`);
      }
      i += 1;
      return next;
    };

    if (arg === "--help" || arg === "-h") {
      opts.showHelp = true;
      continue;
    }
    if (arg === "--cwd") {
      opts.cwd = consumeValue();
      continue;
    }
    if (arg === "--max-chars") {
      opts.maxChars = parseIntFlag(arg, consumeValue());
      continue;
    }
    if (arg === "--from-file") {
      const filePath = consumeValue();
      if (!filePath.trim()) {
        throw new Error("Missing file path after --from-file");
      }
      opts.fromFile = filePath;
      continue;
    }
    if (arg === "--json") {
      opts.jsonRaw = consumeValue();
      continue;
    }
    if (arg === "--stdin") {
      opts.explicitStdin = true;
      continue;
    }

    if (tool === "batch_search") {
      if (arg === "--text" || arg === "-t") {
        pushScopedQuery({ type: "text", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--regex" || arg === "-r") {
        pushScopedQuery({ type: "regex", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--glob" || arg === "-g") {
        pushScopedQuery({ type: "glob", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--fuzzy" || arg === "-f") {
        pushScopedQuery({ type: "fuzzy", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--git") {
        pushScopedQuery({ type: "git", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--type") {
        const rawType = consumeValue().trim().toLowerCase();
        if (!SEARCH_QUERY_TYPES.has(rawType as SearchQuery["type"])) {
          throw new Error(
            `Invalid --type: ${rawType} (expected text, regex, glob, fuzzy, or git)`,
          );
        }
        pendingType = rawType as SearchQuery["type"];
        continue;
      }
      if (arg === "--pattern") {
        const explicit = pendingType !== undefined;
        pushScopedQuery({ type: pendingType ?? "text", pattern: consumeValue() }, explicit);
        continue;
      }
      if (arg === "--path" || arg === "-p") {
        pendingMods.path = consumeValue();
        continue;
      }
      if (arg === "--file-type") {
        pendingMods.fileType = consumeValue();
        continue;
      }
      if (arg === "--glob-filter") {
        pendingMods.glob = consumeValue();
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue().trim().toLowerCase();
        if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
          throw new Error(`Invalid --output-mode: ${mode}`);
        }
        pendingMods.outputMode = mode;
        continue;
      }
      if (arg === "--sort-by") {
        const sortBy = consumeValue().trim().toLowerCase();
        if (sortBy !== "path" && sortBy !== "mtime") {
          throw new Error(`Invalid --sort-by: ${sortBy}`);
        }
        pendingMods.sortBy = sortBy;
        continue;
      }
      if (arg === "--context" || arg === "-C") {
        pendingMods.contextLines = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-results") {
        pendingMods.maxResults = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--ignore-case" || arg === "-i") {
        pendingMods.caseSensitive = false;
        continue;
      }
      if (arg === "--multiline") {
        pendingMods.multiline = true;
        continue;
      }
    } else if (tool === "read_slices") {
      if (arg === "--outline" || arg === "-o") {
        opts.outlineFiles.push(consumeValue());
        continue;
      }
    } else if (tool === "run_checks") {
      if (arg === "--compact") {
        opts.outputMode = "compact";
        continue;
      }
      if (arg === "--full") {
        opts.outputMode = "full";
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue().trim().toLowerCase();
        if (mode !== "compact" && mode !== "full") {
          throw new Error(`Invalid --output-mode for check: ${mode}`);
        }
        opts.outputMode = mode;
        continue;
      }
      if (arg === "--concurrency") {
        opts.concurrency = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--timeout") {
        opts.timeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
    } else if (tool === "apply_edits") {
      if (arg === "--best-effort") {
        opts.bestEffort = true;
        continue;
      }
      if (arg === "--dry-run") {
        opts.dryRun = true;
        continue;
      }
      if (arg === "--diff") {
        opts.diff = true;
        continue;
      }
      if (arg === "--verify") {
        opts.verify = consumeValue();
        continue;
      }
      if (arg === "--verify-timeout") {
        opts.verifyTimeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-verify-chars") {
        opts.maxVerifyChars = parseIntFlag(arg, consumeValue());
        continue;
      }
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${rawArg}' for '${tool}'. Run with '--cli --help' for usage.`);
    }
    if (tool === "batch_search") {
      const explicit = pendingType !== undefined;
      pushScopedQuery({ type: pendingType ?? "text", pattern: rawArg }, explicit);
    } else {
      opts.positionals.push(rawArg);
    }
  }

  opts.trailingSearchType = pendingType;
  opts.trailingSearchMods = pendingMods;
  return opts;
}

export async function runAgyFastCli(
  argv: string[],
  io: CliIo = {},
): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const defaultCwd = io.cwd ?? process.cwd();

  const cmdArg = argv[0];
  if (!cmdArg || cmdArg === "--help" || cmdArg === "-h" || cmdArg === "help") {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  const rest = argv.slice(1);
  const tool = resolveCliToolAlias(cmdArg);
  if (!tool) {
    stderr.write(
      `Error: unknown --cli command '${cmdArg}'. Expected one of: search, outline, slice, edit, check (or --help).\n`,
    );
    return 1;
  }

  let opts: ParsedCliOptions;
  try {
    opts = parseToolFlags(tool, rest);
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (opts.showHelp) {
    stdout.write(`${formatCliUsage()}\n`);
    return 0;
  }

  if (opts.cwd !== undefined && !opts.cwd.trim()) {
    stderr.write("Error: '--cwd' must be a non-empty directory path.\n");
    return 1;
  }

  const explicitJsonSources = [
    opts.jsonRaw !== undefined,
    opts.fromFile !== undefined,
    opts.explicitStdin,
  ].filter(Boolean).length;
  if (explicitJsonSources > 1) {
    stderr.write("Error: options '--from-file', '--json', and '--stdin' cannot be combined.\n");
    return 1;
  }

  const hasConflictingShorthand =
    opts.positionals.length > 0 ||
    opts.searchQueries.length > 0 ||
    opts.outlineFiles.length > 0 ||
    opts.trailingSearchType !== undefined ||
    Object.keys(opts.trailingSearchMods).length > 0;
  if (explicitJsonSources > 0 && hasConflictingShorthand) {
    stderr.write(
      "Error: cannot combine '--from-file'/'--json'/'--stdin' with positional arguments or query modifiers.\n",
    );
    return 1;
  }

  let jsonInput: Record<string, unknown> | null = null;
  try {
    if (opts.fromFile !== undefined) {
      jsonInput = await readJsonPayloadFromFile(
        opts.fromFile,
        opts.cwd ?? defaultCwd,
        tool,
      );
    } else if (opts.jsonRaw !== undefined) {
      jsonInput = parseJsonPayload(opts.jsonRaw, tool);
    } else if (opts.explicitStdin || !hasConflictingShorthand) {
      const stdinText = (await readStdinText(stdin, opts.explicitStdin)).trim();
      if (stdinText) {
        jsonInput = parseJsonPayload(stdinText, tool);
      } else if (opts.explicitStdin) {
        stderr.write("Error: '--stdin' was specified but stdin is empty.\n");
        return 1;
      }
    }
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let effectiveCwd: string;
  if (opts.cwd !== undefined) {
    effectiveCwd = opts.cwd;
  } else if (
    jsonInput &&
    Object.prototype.hasOwnProperty.call(jsonInput, "cwd") &&
    jsonInput.cwd !== undefined
  ) {
    if (typeof jsonInput.cwd !== "string" || !jsonInput.cwd.trim()) {
      stderr.write("Error: 'cwd' in JSON input must be a non-empty string.\n");
      return 1;
    }
    effectiveCwd = jsonInput.cwd;
  } else {
    effectiveCwd = defaultCwd;
  }

  let result: { text: string; isError: boolean };

  if (tool === "batch_search") {
    let payload: BatchSearchInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as BatchSearchInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      const queries: SearchQuery[] = [
        ...opts.searchQueries.map((q, idx): SearchQuery =>
          opts.trailingSearchType !== undefined && opts.implicitTypeQueryIndices.has(idx)
            ? { ...q, type: opts.trailingSearchType }
            : q,
        ),
        ...opts.positionals.map(
          (pattern): SearchQuery => ({ type: opts.trailingSearchType ?? "text", pattern }),
        ),
      ].map((q) => applySearchModifiers(q, opts.trailingSearchMods));
      if (queries.length === 0) {
        stderr.write(
          "Error: 'search' requires at least one query (--text/--regex/--glob/--fuzzy/--git/--pattern, --json, or JSON on stdin).\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        queries,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runBatchSearch(payload);
  } else if (tool === "quick_outline") {
    let payload: QuickOutlineInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as QuickOutlineInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'outline' requires one or more file paths (e.g. --cli outline src/a.ts src/b.ts) or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        paths: opts.positionals,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runQuickOutline(payload);
  } else if (tool === "read_slices") {
    let payload: ReadSlicesInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as ReadSlicesInput),
        cwd: effectiveCwd,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0 && opts.outlineFiles.length === 0) {
        stderr.write(
          "Error: 'slice' requires lineRanges specs (e.g. src/a.ts:1-60), --outline <file>, or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        ...(opts.outlineFiles.length > 0 ? { outlines: opts.outlineFiles } : {}),
        ...(opts.positionals.length > 0 ? { lineRanges: opts.positionals } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runReadSlices(payload);
  } else if (tool === "apply_edits") {
    if (!jsonInput) {
      stderr.write(
        "Error: 'edit' requires JSON input via --from-file <path.json>, --json, or stdin (e.g. {\"edits\":[...],\"bestEffort\":true}).\n",
      );
      return 1;
    }
    const effectiveMaxVerifyChars =
      opts.maxVerifyChars ??
      (opts.maxChars !== undefined
        ? Math.max(300, Math.min(7500, opts.maxChars))
        : undefined);
    const payload: ApplyEditsInput = {
      ...(jsonInput as unknown as ApplyEditsInput),
      cwd: effectiveCwd,
      ...(opts.bestEffort !== undefined ? { bestEffort: opts.bestEffort } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.diff !== undefined ? { diff: opts.diff } : {}),
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
      ...(opts.verifyTimeoutSec !== undefined
        ? { verifyTimeoutSec: opts.verifyTimeoutSec }
        : {}),
      ...(effectiveMaxVerifyChars !== undefined
        ? { maxVerifyChars: effectiveMaxVerifyChars }
        : {}),
    };
    result = await runApplyEdits(payload);
  } else {
    let payload: RunChecksInput;
    if (jsonInput) {
      payload = {
        ...(jsonInput as unknown as RunChecksInput),
        cwd: effectiveCwd,
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'check' requires one or more shell command strings (e.g. --cli check \"npm run typecheck\" \"npm test\") or JSON input.\n",
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        commands: opts.positionals.map((command) => ({ command })),
        ...(opts.outputMode !== undefined ? { outputMode: opts.outputMode } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      };
    }
    result = await runChecks(payload);
  }

  stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  return shouldCliExitNonZero(tool, result) ? 1 : 0;
}

export function shouldCliExitNonZero(
  tool: CliCanonicalTool,
  result: { text: string; isError: boolean },
): boolean {
  if (result.isError) return true;
  if (tool === "run_checks") {
    return /^Checks:\s+\d+\/\d+\s+passed,\s+(?:[1-9]\d*\s+failed|[1-9]\d*\s+not run)\b/.test(
      result.text,
    );
  }
  if (tool === "apply_edits") {
    return /(?:^|\n)Verify \[(?:FAIL|TIMEOUT|ERROR)\b/.test(result.text);
  }
  if (tool === "quick_outline" || tool === "read_slices") {
    const hasHealthySection = /^## (?:Outline|Slice): .+ \(\d+ lines\)$/m.test(result.text);
    const hasErrorSection = /^## (?:Outline|Slice): [^\n]*\nERROR: /m.test(result.text);
    return hasErrorSection && !hasHealthySection;
  }
  if (tool === "batch_search") {
    const sections = result.text
      .split(/(?=(?:^|\n)## Query \d+ \[)/)
      .map((s) => s.replace(/^\n+/, ""))
      .filter((s) => /^## Query \d+ \[/.test(s));
    if (sections.length === 0) return false;
    return sections.every(
      (sec) =>
        /^## Query \d+ \[(?:text|regex|glob|fuzzy)\] [^\n]*\nERROR: /.test(sec) ||
        /^## Query \d+ \[git\] [^\n]*\nERROR: (?:Path does not exist:|git (?:query timed out|execution error:|exited with code )|Flag '|Mutating |Invalid |Unsupported |fatal:|error:)/.test(
          sec,
        ),
    );
  }
  return false;
}
