#!/usr/bin/env node
// agy-fast Offline Transcript Benchmark CLI


// src/benchmark.ts
import { promises as fs2 } from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/benchmark-core.ts
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
var BLOCKING_TOOLS = /* @__PURE__ */ new Set([
  "ask_question",
  "swarm_wait",
  "schedule",
  "manage_subagents",
  "wait_for_subagents"
]);
var PLAN_MODE_TOOLS = /* @__PURE__ */ new Set(["enter_plan_mode", "exit_plan_mode"]);
var PLAN_MODE_NOTICE_RE = /\[plan review(?: due)?\]|Plan mode is (?:on|off):/i;
var READONLY_SIMPLE_CMDS = /* @__PURE__ */ new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "tree",
  "wc",
  "head",
  "tail",
  "cat",
  "stat",
  "file",
  "get-childitem",
  "gci",
  "select-string",
  "sls",
  "get-content",
  "gc",
  "test-path"
]);
var NULL_REDIRECT_TARGET_RE = /^(?:\/dev\/null|nul|\$null)$/i;
var BENIGN_GLUE_CMDS = /* @__PURE__ */ new Set([
  "cd",
  "true",
  ":",
  "echo",
  "printf",
  "pwd",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "rev",
  "paste",
  "fold",
  "basename",
  "dirname",
  "less",
  "more"
]);
var FIND_MUTATING_ARGS = /* @__PURE__ */ new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls"
]);
var FD_MUTATING_ARGS = /* @__PURE__ */ new Set(["-x", "--exec", "-X", "--exec-batch"]);
var GIT_GLOBAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env"
]);
var GIT_GLOBAL_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--no-pager",
  "-P",
  "--paginate",
  "-p",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks"
]);
var GIT_ALWAYS_READONLY_SUBCMDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "blame",
  "shortlog",
  "describe",
  "ls-tree",
  "cat-file",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "name-rev",
  "merge-base",
  "check-ignore"
]);
var GIT_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format"
]);
var KNOWN_SYSTEM_BIN_PREFIXES = [
  "/bin/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/"
];
var AGY_FAST_TOOL_RE = /(?:^|[_:./-])(batch_search|apply_edits|read_slices|quick_outline|run_checks)$/;
function parseTimeMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
function unwrapJsonString(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
    }
  }
  if (trimmed.startsWith('"') && /<truncated \d+ bytes>/.test(trimmed)) {
    let inner = trimmed.slice(1);
    if (inner.endsWith('"')) inner = inner.slice(0, -1);
    const withoutMarkers = inner.replace(/\r?\n?<truncated \d+ bytes>\r?\n?/g, " ");
    return withoutMarkers.replace(
      /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g,
      (_m, hex, ch) => {
        if (hex !== void 0) {
          return String.fromCharCode(Number.parseInt(hex, 16));
        }
        switch (ch) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "	";
          case "b":
            return "\b";
          case "f":
            return "\f";
          default:
            return ch ?? "";
        }
      }
    );
  }
  return val;
}
function getCallArgs(call) {
  const raw = call.args ?? call.arguments;
  if (!raw) return void 0;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return void 0;
    }
    return void 0;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return void 0;
}
function getCommandString(args) {
  if (!args) return "";
  const val = args.CommandLine ?? args.commandLine ?? args.command ?? args.cmd ?? "";
  return unwrapJsonString(val);
}
function getTargetPath(args) {
  if (!args) return "";
  const val = args.Path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.file_path ?? args.filePath ?? "";
  return unwrapJsonString(val);
}
function parseSafeShellSegments(cmd) {
  const segments = [];
  let current = [];
  const len = cmd.length;
  let i = 0;
  const pushSegment = () => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };
  const readWord = () => {
    let value = "";
    let quoted = false;
    let hasChars = false;
    let isEnvAssign = false;
    while (i < len) {
      const ch = cmd[i];
      if (ch === "'") {
        quoted = true;
        hasChars = true;
        i += 1;
        while (i < len && cmd[i] !== "'") {
          value += cmd[i];
          i += 1;
        }
        if (i < len) i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        hasChars = true;
        i += 1;
        while (i < len && cmd[i] !== '"') {
          const inner = cmd[i];
          if (inner === "\\" && i + 1 < len) {
            const nxt = cmd[i + 1];
            if (nxt === "\n") {
              i += 2;
              continue;
            }
            if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
              value += nxt;
              i += 2;
              continue;
            }
          }
          if (inner === "`" || inner === "$" && cmd[i + 1] === "(") {
            return null;
          }
          value += inner;
          i += 1;
        }
        if (i < len) i += 1;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < len) {
          const nxt = cmd[i + 1];
          if (nxt === "\n") {
            i += 2;
            continue;
          }
          if (nxt === "\r" && cmd[i + 2] === "\n") {
            i += 3;
            continue;
          }
          value += nxt;
          hasChars = true;
          i += 2;
          continue;
        }
        value += ch;
        hasChars = true;
        i += 1;
        continue;
      }
      if (ch === "`" || ch === "$" && cmd[i + 1] === "(") {
        return null;
      }
      if (ch === " " || ch === "	" || ch === "\r" || ch === "\n" || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">" || ch === "(" || ch === ")") {
        break;
      }
      if (ch === "=" && !quoted && !isEnvAssign && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        isEnvAssign = true;
      }
      value += ch;
      hasChars = true;
      i += 1;
    }
    return hasChars ? { value, quoted, isEnvAssign } : { value: "", quoted: false, isEnvAssign: false };
  };
  while (i < len) {
    const ch = cmd[i];
    if (ch === " " || ch === "	") {
      i += 1;
      continue;
    }
    if (ch === "\\" && (cmd[i + 1] === "\n" || cmd[i + 1] === "\r" && cmd[i + 2] === "\n")) {
      i += cmd[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (ch === "#") {
      while (i < len && cmd[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === "|") {
      pushSegment();
      i += cmd[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (cmd[i + 1] === "&") {
        pushSegment();
        i += 2;
        continue;
      }
      if (cmd[i + 1] === ">") {
        i += cmd[i + 2] === ">" ? 3 : 2;
        while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
        const target = readWord();
        if (!target || !NULL_REDIRECT_TARGET_RE.test(target.value)) return null;
        continue;
      }
      return null;
    }
    if (ch === "(" || ch === ")") {
      return null;
    }
    let savedPos = i;
    let hasFdPrefix = false;
    while (i < len && cmd[i] >= "0" && cmd[i] <= "9") {
      i += 1;
      hasFdPrefix = true;
    }
    if (hasFdPrefix && (cmd[i] === ">" || cmd[i] === "<")) {
    } else {
      i = savedPos;
    }
    const op = cmd[i];
    if (op === ">") {
      i += 1;
      if (cmd[i] === "&") {
        i += 1;
        while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
        const target2 = readWord();
        if (!target2 || !/^(?:\d+|-)$/.test(target2.value)) return null;
        continue;
      }
      if (cmd[i] === ">" || cmd[i] === "|") i += 1;
      while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
      const target = readWord();
      if (!target || !NULL_REDIRECT_TARGET_RE.test(target.value)) return null;
      continue;
    }
    if (op === "<") {
      if (cmd[i + 1] === "<") {
        if (cmd[i + 2] === "<") {
          i += 3;
          while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
          const word = readWord();
          if (!word) return null;
          continue;
        }
        return null;
      }
      if (cmd[i + 1] === ">") {
        return null;
      }
      i += 1;
      if (cmd[i] === "&") i += 1;
      while (i < len && (cmd[i] === " " || cmd[i] === "	")) i += 1;
      const target = readWord();
      if (!target) return null;
      continue;
    }
    const tok = readWord();
    if (!tok) return null;
    if (tok.value.length > 0 || tok.quoted) {
      current.push(tok);
    }
  }
  pushSegment();
  return segments;
}
function normalizeCommandName(raw) {
  for (const prefix of KNOWN_SYSTEM_BIN_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const rest = raw.slice(prefix.length);
      if (rest && !rest.includes("/")) return rest;
    }
  }
  return raw;
}
function isSedMutating(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "--in-place" || a.startsWith("--in-place=")) return true;
    if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
      i += 1;
      continue;
    }
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const flag = a[j];
        if (flag === "e" || flag === "f") break;
        if (flag === "i") return true;
      }
    }
  }
  return false;
}
function isAwkMutating(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "-i" && args[i + 1] === "inplace") return true;
    if (a === "-iinplace" || a === "--include=inplace") return true;
    if (a === "--include" && args[i + 1] === "inplace") return true;
  }
  return false;
}
function isReadonlyGitBranch(args) {
  let explicitList = false;
  let positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionalCount += args.length - i - 1;
      break;
    }
    if (a === "--list") {
      explicitList = true;
      continue;
    }
    if (a === "--delete" || a === "--move" || a === "--copy" || a === "--force" || a === "--unset-upstream" || a === "--edit-description" || a === "--create-reflog" || a === "--track" || a === "--no-track" || a === "--set-upstream-to" || a.startsWith("--set-upstream-to=")) {
      return false;
    }
    if (GIT_BRANCH_VALUE_FLAGS.has(a)) {
      if (a === "--contains" || a === "--no-contains" || a === "--merged" || a === "--no-merged" || a === "--points-at") {
        explicitList = true;
      }
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (a.startsWith("--")) {
      const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (flagName === "--contains" || flagName === "--no-contains" || flagName === "--merged" || flagName === "--no-merged" || flagName === "--points-at") {
        explicitList = true;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (/[dDmMcCfu]/.test(a.slice(1))) return false;
      if (a.slice(1).includes("l")) explicitList = true;
      continue;
    }
    positionalCount += 1;
  }
  return explicitList || positionalCount === 0;
}
function isReadonlyGitRemote(args) {
  for (const a of args) {
    if (a === "-v" || a === "--verbose") continue;
    if (a === "show" || a === "get-url") return true;
    return false;
  }
  return true;
}
function isReadonlyGitTag(args) {
  let explicitList = false;
  let positionalCount = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionalCount += args.length - i - 1;
      break;
    }
    if (a === "-l" || a === "--list" || a === "--verify") {
      explicitList = true;
      continue;
    }
    if (a === "--delete" || a === "--annotate" || a === "--sign" || a === "--force" || a === "--message" || a.startsWith("--message=") || a === "--file" || a.startsWith("--file=") || a === "--local-user" || a.startsWith("--local-user=")) {
      return false;
    }
    if (GIT_BRANCH_VALUE_FLAGS.has(a)) {
      if (a === "--contains" || a === "--no-contains" || a === "--merged" || a === "--no-merged" || a === "--points-at") {
        explicitList = true;
      }
      if (args[i + 1] && !args[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (a.startsWith("-") && !a.startsWith("--") && a.length > 1) {
      if (/^-n\d*$/.test(a)) {
        explicitList = true;
        continue;
      }
      if (/[dasufmF]/.test(a.slice(1))) return false;
      if (/[lv]/.test(a.slice(1))) explicitList = true;
      continue;
    }
    if (a.startsWith("--")) {
      const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (flagName === "--contains" || flagName === "--no-contains" || flagName === "--merged" || flagName === "--no-merged" || flagName === "--points-at") {
        explicitList = true;
      }
      continue;
    }
    positionalCount += 1;
  }
  return explicitList || positionalCount === 0;
}
function isReadonlyGit(args) {
  let idx = 0;
  while (idx < args.length) {
    const a = args[idx];
    if (!a.startsWith("-")) break;
    if (GIT_GLOBAL_BOOL_FLAGS.has(a)) {
      idx += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(a)) {
      idx += 2;
      continue;
    }
    if (a.startsWith("-C") && a.length > 2 || a.startsWith("-c") && a.length > 2 || a.startsWith("--git-dir=") || a.startsWith("--work-tree=") || a.startsWith("--namespace=") || a.startsWith("--super-prefix=") || a.startsWith("--config-env=")) {
      idx += 1;
      continue;
    }
    return false;
  }
  const subcmd = args[idx];
  if (!subcmd) return false;
  const subArgs = args.slice(idx + 1);
  if (GIT_ALWAYS_READONLY_SUBCMDS.has(subcmd)) {
    if (subArgs.some((a) => a === "--output" || a.startsWith("--output="))) {
      return false;
    }
    return true;
  }
  if (subcmd === "branch") return isReadonlyGitBranch(subArgs);
  if (subcmd === "remote") return isReadonlyGitRemote(subArgs);
  if (subcmd === "tag") return isReadonlyGitTag(subArgs);
  return false;
}
function classifyShellSegment(tokens) {
  let idx = 0;
  while (idx < tokens.length && tokens[idx].isEnvAssign) {
    idx += 1;
  }
  if (idx >= tokens.length) return "benign_glue";
  if (normalizeCommandName(tokens[idx].value) === "env") {
    idx += 1;
    while (idx < tokens.length) {
      const t = tokens[idx];
      if (t.value === "--") {
        idx += 1;
        break;
      }
      if (t.value === "-i") {
        idx += 1;
        continue;
      }
      if (t.value === "-u" && idx + 1 < tokens.length) {
        idx += 2;
        continue;
      }
      if (t.isEnvAssign) {
        idx += 1;
        continue;
      }
      if (t.value.startsWith("-")) return "other";
      break;
    }
    if (idx >= tokens.length) return "other";
  }
  const cmdName = normalizeCommandName(tokens[idx].value);
  const lowerCmd = cmdName.toLowerCase();
  const args = tokens.slice(idx + 1).map((t) => t.value);
  if (READONLY_SIMPLE_CMDS.has(cmdName) || READONLY_SIMPLE_CMDS.has(lowerCmd)) {
    return "readonly_search";
  }
  if (cmdName === "find") {
    return args.some((a) => FIND_MUTATING_ARGS.has(a)) ? "other" : "readonly_search";
  }
  if (cmdName === "fd") {
    return args.some(
      (a) => FD_MUTATING_ARGS.has(a) || a.startsWith("--exec=") || a.startsWith("--exec-batch=")
    ) ? "other" : "readonly_search";
  }
  if (cmdName === "sed") {
    return isSedMutating(args) ? "other" : "readonly_search";
  }
  if (cmdName === "awk" || cmdName === "gawk") {
    return isAwkMutating(args) ? "other" : "readonly_search";
  }
  if (cmdName === "git") {
    return isReadonlyGit(args) ? "readonly_search" : "other";
  }
  if (BENIGN_GLUE_CMDS.has(cmdName)) {
    return "benign_glue";
  }
  return "other";
}
function isReadonlySearchShell(cmd) {
  if (!cmd.trim()) return false;
  const segments = parseSafeShellSegments(cmd);
  if (!segments || segments.length === 0) return false;
  let hasReadonlySearch = false;
  for (const seg of segments) {
    const kind = classifyShellSegment(seg);
    if (kind === "other") return false;
    if (kind === "readonly_search") hasReadonlySearch = true;
  }
  return hasReadonlySearch;
}
function parseTranscriptJsonlLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return { kind: "empty" };
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainRecord(parsed)) {
      return { kind: "step", step: parsed };
    }
    return { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
}
async function parseTranscriptJsonlFileDetailed(filePath) {
  const steps = [];
  let malformedLines = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });
  try {
    for await (const line of rl) {
      const res = parseTranscriptJsonlLine(line);
      if (res.kind === "step") {
        steps.push(res.step);
      } else if (res.kind === "malformed") {
        malformedLines++;
      }
    }
  } finally {
    stream.on("error", () => {
    });
    rl.close();
    stream.destroy();
  }
  return { steps, malformedLines };
}
var AGY_FAST_CLI_ALIAS_MAP = {
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
  run_checks: "run_checks"
};
function splitUnquotedShellSegments(cmd) {
  const out = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < cmd.length) {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      out.push(cmd.slice(start, i));
      if ((ch === "|" || ch === "&") && cmd[i + 1] === ch) i += 1;
      start = i + 1;
    }
  }
  out.push(cmd.slice(start));
  return out;
}
function tokenizeCliSegment(seg) {
  const tokens = [];
  let i = 0;
  const len = seg.length;
  while (i < len) {
    while (i < len && (seg[i] === " " || seg[i] === "	" || seg[i] === "\r" || seg[i] === "\n")) {
      i++;
    }
    if (i >= len) break;
    const startsQuoted = seg[i] === "'" || seg[i] === '"';
    let value = "";
    while (i < len) {
      const ch = seg[i];
      if (ch === " " || ch === "	" || ch === "\r" || ch === "\n") break;
      if (ch === "'") {
        i++;
        while (i < len && seg[i] !== "'") {
          value += seg[i];
          i++;
        }
        if (i < len && seg[i] === "'") i++;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < len && seg[i] !== '"') {
          if (seg[i] === "\\" && i + 1 < len && (seg[i + 1] === '"' || seg[i + 1] === "\\")) {
            value += seg[i + 1];
            i += 2;
            continue;
          }
          value += seg[i];
          i++;
        }
        if (i < len && seg[i] === '"') i++;
        continue;
      }
      if (ch === "\\" && i + 1 < len && (seg[i + 1] === " " || seg[i + 1] === "	" || seg[i + 1] === '"' || seg[i + 1] === "'" || seg[i + 1] === "\\")) {
        value += seg[i + 1];
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }
    tokens.push({ value, startsQuoted });
  }
  return tokens;
}
function baseNameAnySep(p) {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
}
function stripBinExt(name) {
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}
var BARE_REDIRECT_OP_RE = /^(?:\d*(?:>>?|<<-?|<>|<<<)|&>>?)$/;
var ANY_REDIRECT_TOKEN_RE = /^(?:\d*[<>]|&>)/;
var ENV_ASSIGN_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
function stripShellRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsQuoted && ANY_REDIRECT_TOKEN_RE.test(tok.value)) {
      if (BARE_REDIRECT_OP_RE.test(tok.value)) {
        i += 1;
      }
      continue;
    }
    out.push(tok.value);
  }
  return out;
}
function parseAgyFastCliSegment(seg) {
  if (!seg.includes("--cli")) return null;
  const tokens = tokenizeCliSegment(seg);
  if (tokens.length < 3) return null;
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (!t.startsQuoted && ENV_ASSIGN_TOKEN_RE.test(t.value)) {
      idx++;
      continue;
    }
    if (!t.startsQuoted && t.value === "env") {
      idx++;
      while (idx < tokens.length && !tokens[idx].startsQuoted && tokens[idx].value.startsWith("-")) {
        const flag = tokens[idx].value;
        if (flag === "-u" || flag === "--unset" || flag === "-C" || flag === "--chdir") {
          idx += 2;
        } else {
          idx++;
        }
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;
  let binBase = stripBinExt(baseNameAnySep(tokens[idx].value)).toLowerCase();
  if (binBase === "npx") {
    idx++;
    while (idx < tokens.length) {
      const flag = tokens[idx].value;
      if (flag === "-p" || flag === "--package") {
        idx += 2;
        continue;
      }
      if (flag.startsWith("-")) {
        idx++;
        continue;
      }
      break;
    }
    if (idx >= tokens.length) return null;
    binBase = stripBinExt(baseNameAnySep(tokens[idx].value)).toLowerCase();
  }
  let cliFlagIdx = -1;
  if (binBase === "node") {
    idx++;
    while (idx < tokens.length && tokens[idx].value.startsWith("--")) {
      idx++;
    }
    if (idx >= tokens.length) return null;
    const scriptBase = baseNameAnySep(tokens[idx].value).toLowerCase();
    if (scriptBase === "mcp-server.mjs") {
      cliFlagIdx = idx + 1;
    } else if (scriptBase === "install.mjs" && tokens[idx + 1]?.value === "mcp") {
      cliFlagIdx = idx + 2;
    } else {
      return null;
    }
  } else if (binBase === "agy-fast-mcp") {
    cliFlagIdx = idx + 1;
  } else if (binBase === "agy-fast" && tokens[idx + 1]?.value === "mcp") {
    cliFlagIdx = idx + 2;
  } else {
    return null;
  }
  if (tokens[cliFlagIdx]?.value !== "--cli") return null;
  const subcmd = tokens[cliFlagIdx + 1]?.value;
  if (!subcmd) return null;
  const canonical = AGY_FAST_CLI_ALIAS_MAP[subcmd.toLowerCase()];
  if (!canonical) return null;
  return {
    tool: canonical,
    args: stripShellRedirections(tokens.slice(cliFlagIdx + 2))
  };
}
function extractAgyFastCliInvocation(cmd) {
  if (!cmd || !cmd.includes("--cli")) return null;
  for (const seg of splitUnquotedShellSegments(cmd)) {
    const inv = parseAgyFastCliSegment(seg);
    if (inv) return inv;
  }
  return null;
}
function extractAgyFastCliToolName(cmd) {
  return extractAgyFastCliInvocation(cmd)?.tool ?? null;
}
function extractAgyFastToolName(call) {
  const name = call.name ?? "";
  if (name === "call_mcp_tool") {
    const callArgs = getCallArgs(call);
    const serverName = unwrapJsonString(
      callArgs?.ServerName ?? callArgs?.serverName ?? callArgs?.server_name ?? ""
    );
    const toolName = unwrapJsonString(
      callArgs?.ToolName ?? callArgs?.toolName ?? callArgs?.tool_name ?? ""
    );
    const isFastServer = !serverName || /(?:^|[_:/-])fast$/i.test(serverName) || /agy-fast/i.test(serverName);
    const m2 = isFastServer ? AGY_FAST_TOOL_RE.exec(toolName) : null;
    return m2?.[1] ?? null;
  }
  if (name === "run_command") {
    return extractAgyFastCliToolName(getCommandString(getCallArgs(call)));
  }
  const m = AGY_FAST_TOOL_RE.exec(name);
  return m?.[1] ?? null;
}
function sessionHasStartupSnapshot(steps) {
  const identitySteps = fullSessionStepsMap.get(steps) ?? steps;
  for (const step of identitySteps) {
    if (typeof step.content !== "string") continue;
    if (!step.content.includes("[agy-fast startup snapshot]")) continue;
    if (step.type === "SYSTEM_MESSAGE") return true;
    if (step.type === "USER_INPUT" && step.content.includes("SessionStart")) {
      return true;
    }
  }
  return false;
}
function isPlainRecord(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}
function extractAgyFastInnerArgs(call) {
  const outer = getCallArgs(call);
  if (!outer) return null;
  if ((call.name ?? "") !== "call_mcp_tool") return outer;
  let inner = outer.Arguments ?? outer.arguments;
  for (let i = 0; i < 2 && typeof inner === "string"; i++) {
    try {
      inner = JSON.parse(inner);
    } catch {
      break;
    }
  }
  return isPlainRecord(inner) ? inner : null;
}
function maybeParseJsonValue(val) {
  let cur = val;
  for (let i = 0; i < 2 && typeof cur === "string"; i++) {
    const trimmed = cur.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed === "true" || trimmed === "false" || trimmed === "null") {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === cur) break;
        cur = parsed;
        continue;
      } catch {
        return cur;
      }
    }
    break;
  }
  return cur;
}
function countLineRangeSpecOps(spec) {
  const trimmed = spec.trim();
  if (!trimmed) return 0;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0) return 1;
  const rangePart = trimmed.slice(lastColon + 1).trim();
  if (!/^L?\d+/i.test(rangePart)) return 1;
  const parts = rangePart.split(",").filter((p) => p.trim().length > 0);
  return Math.max(1, parts.length);
}
function countApplyEditsOps(inner, cliVerify) {
  const eds = maybeParseJsonValue(inner.edits);
  let editOps = 0;
  if (Array.isArray(eds)) {
    for (const item of eds) {
      if (!isPlainRecord(item)) return 1;
      const hunks = maybeParseJsonValue(item.hunks);
      editOps += Array.isArray(hunks) && hunks.length > 0 ? hunks.length : 1;
    }
  }
  if (editOps === 0) return 1;
  const dryRun = maybeParseJsonValue(inner.dryRun) === true;
  const rawVerify = cliVerify !== void 0 ? cliVerify : maybeParseJsonValue(inner.verify);
  const verifyStr = typeof rawVerify === "string" ? unwrapJsonString(rawVerify).trim() : "";
  return editOps + (!dryRun && verifyStr.length > 0 ? 1 : 0);
}
function countReadSlicesOps(inner) {
  let ops = 0;
  const outlines = maybeParseJsonValue(inner.outlines);
  if (Array.isArray(outlines)) {
    for (const item of outlines) {
      if (typeof item === "string" && item.trim().length > 0) ops += 1;
    }
  } else if (typeof outlines === "string" && outlines.trim().length > 0) {
    ops += 1;
  }
  const slices = maybeParseJsonValue(inner.slices);
  if (Array.isArray(slices)) {
    for (const item of slices) {
      if (typeof item === "string") {
        ops += countLineRangeSpecOps(item);
      } else if (isPlainRecord(item)) {
        const ranges = maybeParseJsonValue(item.ranges);
        ops += Array.isArray(ranges) && ranges.length > 0 ? ranges.length : 1;
      }
    }
  }
  const lineRanges = maybeParseJsonValue(inner.lineRanges);
  if (Array.isArray(lineRanges)) {
    for (const item of lineRanges) {
      if (typeof item === "string") ops += countLineRangeSpecOps(item);
    }
  } else if (typeof lineRanges === "string" && lineRanges.trim().length > 0) {
    ops += countLineRangeSpecOps(lineRanges);
  }
  return Math.max(1, ops);
}
function countMcpLogicalOps(fastTool, inner, corrupted) {
  if (corrupted || !inner) return 1;
  if (fastTool === "batch_search") {
    const qs = maybeParseJsonValue(inner.queries);
    return Array.isArray(qs) && qs.length > 0 ? qs.length : 1;
  }
  if (fastTool === "apply_edits") {
    return countApplyEditsOps(inner);
  }
  if (fastTool === "quick_outline") {
    const raw = inner.paths !== void 0 ? inner.paths : inner.outlines !== void 0 ? inner.outlines : inner.files;
    const paths = maybeParseJsonValue(raw);
    return Array.isArray(paths) && paths.length > 0 ? paths.length : 1;
  }
  if (fastTool === "read_slices") {
    return countReadSlicesOps(inner);
  }
  if (fastTool === "run_checks") {
    const cmds = maybeParseJsonValue(inner.commands);
    return Array.isArray(cmds) && cmds.length > 0 ? cmds.length : 1;
  }
  return 1;
}
function inspectMcpRunChecks(inner, corrupted) {
  if (!inner) {
    return { isFullMode: false, isSingleCommand: false, commandCount: null };
  }
  const modeVal = maybeParseJsonValue(inner.outputMode);
  const modeStr = typeof modeVal === "string" ? unwrapJsonString(modeVal).trim() : "";
  const isFullMode = modeStr === "full";
  if (corrupted) {
    return { isFullMode, isSingleCommand: false, commandCount: null };
  }
  const cmds = maybeParseJsonValue(inner.commands);
  if (Array.isArray(cmds) && cmds.length > 0) {
    return {
      isFullMode,
      isSingleCommand: cmds.length === 1,
      commandCount: cmds.length
    };
  }
  return { isFullMode, isSingleCommand: false, commandCount: null };
}
function splitLongFlag(raw, valueFlags) {
  if (raw.startsWith("--")) {
    const eq = raw.indexOf("=");
    if (eq > 2) {
      const candidate = raw.slice(0, eq);
      if (valueFlags.has(candidate)) {
        return { flag: candidate, inlineVal: raw.slice(eq + 1) };
      }
    }
  }
  return { flag: raw, inlineVal: void 0 };
}
var CLI_CHECK_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--cwd",
  "--max-chars",
  "--from-file",
  "--json",
  "--output-mode",
  "--concurrency",
  "--timeout"
]);
function inspectCliRunChecks(args) {
  let cliOutputMode;
  let jsonRaw;
  let positionalCount = 0;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (afterDoubleDash) {
      positionalCount++;
      continue;
    }
    if (raw === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (raw === "-h" || raw === "--help") {
      return { isFullMode: false, isSingleCommand: false, commandCount: null };
    }
    const { flag, inlineVal } = splitLongFlag(raw, CLI_CHECK_VALUE_FLAGS);
    const takeVal = () => {
      if (inlineVal !== void 0) return inlineVal;
      return args[++i];
    };
    if (flag === "--full") {
      cliOutputMode = "full";
      continue;
    }
    if (flag === "--compact") {
      cliOutputMode = "compact";
      continue;
    }
    if (flag === "--output-mode") {
      const val = takeVal()?.trim();
      if (val === "full" || val === "compact") cliOutputMode = val;
      continue;
    }
    if (flag === "--json") {
      jsonRaw = takeVal();
      continue;
    }
    if (CLI_CHECK_VALUE_FLAGS.has(flag)) {
      takeVal();
      continue;
    }
    if (flag === "--stdin" || flag.startsWith("-")) {
      continue;
    }
    positionalCount++;
  }
  let jsonOutputMode;
  let jsonCmdCount = null;
  if (jsonRaw !== void 0) {
    try {
      const parsed = JSON.parse(jsonRaw);
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string" || isPlainRecord(c))) {
        jsonCmdCount = parsed.length;
      } else if (isPlainRecord(parsed)) {
        const modeVal = maybeParseJsonValue(parsed.outputMode);
        const modeStr = typeof modeVal === "string" ? unwrapJsonString(modeVal).trim() : "";
        if (modeStr === "full" || modeStr === "compact") {
          jsonOutputMode = modeStr;
        }
        const cmds = maybeParseJsonValue(parsed.commands);
        if (Array.isArray(cmds) && cmds.every((c) => typeof c === "string" || isPlainRecord(c))) {
          jsonCmdCount = cmds.length;
        }
      }
    } catch {
    }
  }
  const effectiveMode = cliOutputMode ?? jsonOutputMode ?? "compact";
  const commandCount = jsonCmdCount !== null ? jsonCmdCount : positionalCount > 0 ? positionalCount : null;
  return {
    isFullMode: effectiveMode === "full",
    isSingleCommand: commandCount === 1,
    commandCount
  };
}
var CLI_SEARCH_QUERY_FLAGS = /* @__PURE__ */ new Set([
  "--text",
  "-t",
  "--regex",
  "-r",
  "--glob",
  "-g",
  "--fuzzy",
  "-f",
  "--git",
  "--pattern"
]);
var CLI_SEARCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  ...CLI_SEARCH_QUERY_FLAGS,
  "--cwd",
  "--max-chars",
  "--from-file",
  "--json",
  "--type",
  "--path",
  "-p",
  "--file-type",
  "--glob-filter",
  "--output-mode",
  "--sort-by",
  "--context",
  "-C",
  "--max-results"
]);
var CLI_EDIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--cwd",
  "--max-chars",
  "--from-file",
  "--json",
  "--verify",
  "--verify-timeout",
  "--max-verify-chars"
]);
var CLI_SLICE_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--cwd",
  "--max-chars",
  "--from-file",
  "--json",
  "--outline",
  "-o"
]);
var CLI_OUTLINE_VALUE_FLAGS = /* @__PURE__ */ new Set(["--cwd", "--max-chars", "--from-file", "--json"]);
function countCliLogicalOps(inv, runChecksInfo) {
  const { tool, args } = inv;
  if (tool === "run_checks") {
    const info = runChecksInfo ?? inspectCliRunChecks(args);
    return info.commandCount !== null && info.commandCount > 0 ? info.commandCount : 1;
  }
  if (tool === "batch_search") {
    let queryCount = 0;
    let jsonRaw;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const raw = args[i];
      if (afterDoubleDash) {
        queryCount++;
        continue;
      }
      if (raw === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (raw === "-h" || raw === "--help") return 1;
      const { flag, inlineVal } = splitLongFlag(raw, CLI_SEARCH_VALUE_FLAGS);
      const consumeVal = () => inlineVal !== void 0 ? inlineVal : args[++i];
      if (flag === "--json") {
        jsonRaw = consumeVal();
        continue;
      }
      if (CLI_SEARCH_QUERY_FLAGS.has(flag)) {
        consumeVal();
        queryCount++;
        continue;
      }
      if (CLI_SEARCH_VALUE_FLAGS.has(flag)) {
        consumeVal();
        continue;
      }
      if (flag.startsWith("-")) continue;
      queryCount++;
    }
    if (jsonRaw !== void 0) {
      try {
        const parsed = JSON.parse(jsonRaw);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isPlainRecord)) {
          return parsed.length;
        }
        if (isPlainRecord(parsed)) {
          const qs = maybeParseJsonValue(parsed.queries);
          if (Array.isArray(qs) && qs.length > 0 && qs.every(isPlainRecord)) {
            return qs.length;
          }
        }
      } catch {
      }
    }
    return Math.max(1, queryCount);
  }
  if (tool === "quick_outline") {
    let pathCount = 0;
    let jsonRaw;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const raw = args[i];
      if (afterDoubleDash) {
        pathCount++;
        continue;
      }
      if (raw === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (raw === "-h" || raw === "--help") return 1;
      const { flag, inlineVal } = splitLongFlag(raw, CLI_OUTLINE_VALUE_FLAGS);
      const consumeVal = () => inlineVal !== void 0 ? inlineVal : args[++i];
      if (flag === "--json") {
        jsonRaw = consumeVal();
        continue;
      }
      if (CLI_OUTLINE_VALUE_FLAGS.has(flag)) {
        consumeVal();
        continue;
      }
      if (flag.startsWith("-")) continue;
      pathCount++;
    }
    if (jsonRaw !== void 0) {
      try {
        const parsed = JSON.parse(jsonRaw);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === "string")) {
          return parsed.length;
        }
        if (isPlainRecord(parsed)) {
          const ps = maybeParseJsonValue(parsed.paths ?? parsed.outlines ?? parsed.files);
          if (Array.isArray(ps) && ps.length > 0 && ps.every((p) => typeof p === "string")) {
            return ps.length;
          }
        }
      } catch {
      }
    }
    return Math.max(1, pathCount);
  }
  if (tool === "read_slices") {
    let ops = 0;
    let jsonRaw;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const raw = args[i];
      if (afterDoubleDash) {
        ops += countLineRangeSpecOps(raw);
        continue;
      }
      if (raw === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (raw === "-h" || raw === "--help") return 1;
      const { flag, inlineVal } = splitLongFlag(raw, CLI_SLICE_VALUE_FLAGS);
      const consumeVal = () => inlineVal !== void 0 ? inlineVal : args[++i];
      if (flag === "--json") {
        jsonRaw = consumeVal();
        continue;
      }
      if (flag === "--outline" || flag === "-o") {
        consumeVal();
        ops += 1;
        continue;
      }
      if (CLI_SLICE_VALUE_FLAGS.has(flag)) {
        consumeVal();
        continue;
      }
      if (flag.startsWith("-")) continue;
      ops += countLineRangeSpecOps(raw);
    }
    if (jsonRaw !== void 0) {
      try {
        const parsed = JSON.parse(jsonRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.every((item) => typeof item === "string") ? countReadSlicesOps({ lineRanges: parsed }) : countReadSlicesOps({ slices: parsed });
        }
        if (isPlainRecord(parsed)) {
          return countReadSlicesOps(parsed);
        }
      } catch {
      }
    }
    return Math.max(1, ops);
  }
  if (tool === "apply_edits") {
    let jsonRaw;
    let cliVerify;
    let cliDryRun = false;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const raw = args[i];
      if (afterDoubleDash) continue;
      if (raw === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (raw === "-h" || raw === "--help") return 1;
      const { flag, inlineVal } = splitLongFlag(raw, CLI_EDIT_VALUE_FLAGS);
      const consumeVal = () => inlineVal !== void 0 ? inlineVal : args[++i];
      if (flag === "--json") {
        jsonRaw = consumeVal();
        continue;
      }
      if (flag === "--verify") {
        cliVerify = consumeVal();
        continue;
      }
      if (flag === "--dry-run") {
        cliDryRun = true;
        continue;
      }
      if (CLI_EDIT_VALUE_FLAGS.has(flag)) {
        consumeVal();
      }
    }
    if (jsonRaw !== void 0) {
      try {
        const parsed = JSON.parse(jsonRaw);
        if (Array.isArray(parsed)) {
          return countApplyEditsOps(
            { edits: parsed, ...cliDryRun ? { dryRun: true } : {} },
            cliVerify
          );
        }
        if (isPlainRecord(parsed)) {
          return countApplyEditsOps(
            { ...parsed, ...cliDryRun ? { dryRun: true } : {} },
            cliVerify
          );
        }
      } catch {
      }
    }
    return 1 + (!cliDryRun && cliVerify && cliVerify.trim().length > 0 ? 1 : 0);
  }
  return 1;
}
function getCanonicalToolName(call) {
  const name = call.name ?? "";
  if (name === "run_command") {
    const cliTool = extractAgyFastCliToolName(getCommandString(getCallArgs(call)));
    return cliTool ? `agy-fast-cli:${cliTool}` : name;
  }
  if (name !== "call_mcp_tool") return name;
  const callArgs = getCallArgs(call);
  const serverName = unwrapJsonString(
    callArgs?.ServerName ?? callArgs?.serverName ?? callArgs?.server_name ?? ""
  );
  const toolName = unwrapJsonString(
    callArgs?.ToolName ?? callArgs?.toolName ?? callArgs?.tool_name ?? ""
  );
  if (toolName) {
    return serverName ? `call_mcp_tool:${serverName}/${toolName}` : `call_mcp_tool:${toolName}`;
  }
  return name;
}
function hasCorruptedAgyFastArgs(call, fastTool) {
  const inner = extractAgyFastInnerArgs(call);
  if (!inner) return false;
  if (fastTool === "apply_edits") {
    const eds = maybeParseJsonValue(inner.edits);
    if (typeof eds === "boolean" || eds === null) return true;
    if (Array.isArray(eds)) {
      if (eds.length === 0) return true;
      return eds.some((e) => {
        if (!isPlainRecord(e)) return true;
        if (e.hunks !== void 0) {
          const hunks = maybeParseJsonValue(e.hunks);
          if (!Array.isArray(hunks)) return true;
          if (hunks.some((h) => !isPlainRecord(h))) {
            return true;
          }
        }
        return false;
      });
    }
    return false;
  }
  if (fastTool === "batch_search") {
    const qs = maybeParseJsonValue(inner.queries);
    if (typeof qs === "boolean" || qs === null) return true;
    return Array.isArray(qs) && qs.some((q) => !isPlainRecord(q));
  }
  if (fastTool === "read_slices") {
    const outlines = maybeParseJsonValue(inner.outlines);
    if (typeof outlines === "boolean" || outlines === null) return true;
    if (Array.isArray(outlines) && outlines.some((p) => typeof p !== "string")) {
      return true;
    }
    const lineRanges = maybeParseJsonValue(inner.lineRanges);
    if (typeof lineRanges === "boolean" || lineRanges === null) return true;
    if (Array.isArray(lineRanges) && lineRanges.some((lr) => typeof lr !== "string" || lr.trim().length === 0)) {
      return true;
    }
    const slices = maybeParseJsonValue(inner.slices);
    if (typeof slices === "boolean" || slices === null) return true;
    if (Array.isArray(slices)) {
      return slices.some((s) => {
        if (typeof s === "string") return s.trim().length === 0;
        if (!isPlainRecord(s)) return true;
        if (s.ranges !== void 0) {
          const ranges = maybeParseJsonValue(s.ranges);
          if (!Array.isArray(ranges)) return true;
          if (ranges.some((r) => typeof r === "boolean" || r === null)) return true;
        }
        return false;
      });
    }
    return false;
  }
  if (fastTool === "quick_outline") {
    const raw = inner.paths !== void 0 ? inner.paths : inner.outlines !== void 0 ? inner.outlines : inner.files;
    const paths = maybeParseJsonValue(raw);
    if (typeof paths === "boolean" || paths === null) return true;
    return Array.isArray(paths) && paths.some((p) => typeof p !== "string");
  }
  if (fastTool === "run_checks") {
    const cmds = maybeParseJsonValue(inner.commands);
    if (typeof cmds === "boolean" || cmds === null) return true;
    return Array.isArray(cmds) && cmds.some((c) => typeof c !== "string" && !isPlainRecord(c));
  }
  return false;
}
var fullSessionStepsMap = /* @__PURE__ */ new WeakMap();
var SUBAGENT_MESSAGE_SENDER_RE = /\[Message\]\s[^\r\n]*\bsender=([^\s\]]+)/;
function classifySessionKind(steps) {
  const identitySteps = fullSessionStepsMap.get(steps) ?? steps;
  let hasUserRequest = false;
  let hasSwarmWorkerTool = false;
  let hasSubagentSignal = false;
  for (const step of identitySteps) {
    if (step.type === "USER_INPUT") {
      const text = typeof step.content === "string" ? step.content : "";
      const hasMedia = Array.isArray(step.media) && step.media.length > 0;
      if (text.includes("<USER_REQUEST>") || text.trim().length > 0 || hasMedia) {
        hasUserRequest = true;
      }
    }
    if (step.type === "SYSTEM_MESSAGE" && typeof step.content === "string") {
      const m = SUBAGENT_MESSAGE_SENDER_RE.exec(step.content);
      if (m?.[1] && !m[1].includes("/task-")) {
        hasSubagentSignal = true;
      }
    }
    if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const n = tc.name ?? "";
        if (n === "read_board" || n === "post_message" || n === "swarm_wait") {
          hasSwarmWorkerTool = true;
        } else if (n === "send_message") {
          hasSubagentSignal = true;
        }
      }
    }
  }
  if (hasUserRequest) return "main";
  if (hasSwarmWorkerTool) return "swarm";
  if (hasSubagentSignal) return "subagent";
  return "main";
}
function sessionUsesAgyFast(steps) {
  for (const step of steps) {
    if (step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) {
      continue;
    }
    for (const call of step.tool_calls) {
      if (extractAgyFastToolName(call) !== null) return true;
    }
  }
  return false;
}
function filterStepsByTime(steps, sinceMs, untilMs) {
  if (sinceMs === void 0 && untilMs === void 0) return steps;
  const out = [];
  for (const step of steps) {
    const ms = parseTimeMs(step.created_at);
    if (ms === null) continue;
    if (sinceMs !== void 0 && ms < sinceMs) continue;
    if (untilMs !== void 0 && ms > untilMs) continue;
    out.push(step);
  }
  fullSessionStepsMap.set(out, fullSessionStepsMap.get(steps) ?? steps);
  return out;
}
var HOST_METADATA_PREFIX_RE = /^(?:(?:Created At|Completed At):[^\r\n]*(?:\r?\n|$)|\r?\n)+/;
var HOST_SPILL_FIRST_LINE_RE = /^(?:The output was large and was saved to:|(?:The (?:tool's |command's )?|Tool |Command )?output was truncated\b[^\r\n]*output\.txt)/i;
var HOST_SPILL_MULTILINE_HEAD_RE = /^(?:The (?:tool's |command's )?|Tool |Command )?output was truncated\b/i;
var AGY_BUDGET_TRUNCATED_RE = /(?:^|\n)\.\.\.\s*\[truncated:/;
var AGY_MAX_RESULTS_CAPPED_RE = /(?:^|\n)\.\.\.\s*\[truncated(?: at \d+|; showing )/;
var AGY_ERROR_HEAD_RE = /^(?:Encountered error in step execution|Error invalid tool call|Partial edit applied|Atomic edit aborted)\b/;
var AGY_VERIFY_FAILED_RE = /(?:^|\n)Verify \[(?:FAIL\b|TIMEOUT\b|ERROR\b)/;
function stripHostMetadataPrefix(resText) {
  return resText.replace(HOST_METADATA_PREFIX_RE, "");
}
function isHostSpillBody(body) {
  const headLines = body.split(/\r?\n/, 3);
  const firstLine = headLines[0] ?? "";
  if (HOST_SPILL_FIRST_LINE_RE.test(firstLine)) return true;
  if (HOST_SPILL_MULTILINE_HEAD_RE.test(firstLine) && headLines.join("\n").includes("output.txt")) {
    return true;
  }
  return false;
}
function getToolCallId(obj) {
  for (const val of [obj.tool_call_id, obj.call_id, obj.id]) {
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}
function pairToolCallResult(plannerStep, call, callIdx, totalCalls, genericSteps, genericById, genericByIndex, anyGenericHasToolCallId) {
  const callId = getToolCallId(call);
  if (callId !== null) {
    const byId = genericById.get(callId);
    if (byId) return byId;
    if (anyGenericHasToolCallId) return void 0;
  }
  const plannerIdx = plannerStep.step_index;
  if (typeof plannerIdx === "number" && Number.isInteger(plannerIdx)) {
    if (genericByIndex.size > 0) {
      return genericByIndex.get(plannerIdx + 1 + callIdx);
    }
    return void 0;
  }
  if (plannerIdx === void 0 && genericByIndex.size === 0 && genericSteps.length === totalCalls) {
    return genericSteps[callIdx];
  }
  return void 0;
}
function analyzeTranscriptSessions(sessions) {
  let validSessions = 0;
  let mainSessions = 0;
  let subagentSessions = 0;
  let sessionsWithAgyFast = 0;
  let sessionsWithSnapshot = 0;
  let llmTurns = 0;
  let toolTurns = 0;
  let singleToolTurns = 0;
  let totalToolCalls = 0;
  let totalLogicalOps = 0;
  let agyFastLogicalOps = 0;
  let consecutiveSingleChainsExtraTurns = 0;
  let activeTimeSec = 0;
  let llmTimeSec = 0;
  let streamWaitSec = 0;
  let toolExecTimeSec = 0;
  let totalOutputTokens = 0;
  let editFileCalls = 0;
  let redundantSameTurnEditFileCalls = 0;
  let runCommandCalls = 0;
  let readonlySearchRunCommandCalls = 0;
  const agyFastToolCalls = {
    batch_search: 0,
    apply_edits: 0,
    read_slices: 0,
    quick_outline: 0,
    run_checks: 0
  };
  let agyEagerCalls = 0;
  let agyLazyCalls = 0;
  let agyCliCalls = 0;
  let runChecksFullModeCalls = 0;
  let runChecksSingleCommandCalls = 0;
  let mcpSpillCalls = 0;
  let agyTruncatedCalls = 0;
  let agyMaxResultsCappedCalls = 0;
  let agyErrorCalls = 0;
  let agyVerifyFailedCalls = 0;
  let agyUnpairedResultCalls = 0;
  let agyCorruptedArgCalls = 0;
  let agyCorruptedArgWastedSec = 0;
  let agyCorruptedArgWastedOutTokens = 0;
  let swarmWorkerSessions = 0;
  let swarmWorkerSessionsWithAgyFast = 0;
  let multiMcpTurns = 0;
  let multiSameMcpTurns = 0;
  let multiDiffMcpTurns = 0;
  let multiRunCommandTurns = 0;
  let mediaLoadedCount = 0;
  let userMediaCount = 0;
  let toolMediaCount = 0;
  let multimodalHighCtxTurns = 0;
  let multimodalHighCtxUserOnlyTurns = 0;
  let multimodalHighCtxToolTurns = 0;
  let contextSum = 0;
  let contextCount = 0;
  let over150kCount = 0;
  let cacheHitSum = 0;
  let cacheHitCount = 0;
  let turnGapsTotal = 0;
  let turnGapsOver60s = 0;
  const cacheMissAttribution = {
    total: 0,
    planModeSwitch: 0,
    modelSwitch: 0,
    errorRetry: 0,
    activeSlowGap: 0,
    idleOrWaitGap: 0,
    asyncWakeupFast: 0,
    fastReplicaOrPrefixMiss: 0,
    compactionResets: 0,
    contextDilutionTurns: 0,
    sustainedCollapseRuns: 0,
    sustainedCollapseTurns: 0,
    maxConsecutiveMisses: 0
  };
  for (const steps of sessions) {
    if (steps.length === 0) continue;
    let hasPlanner = false;
    let sessionFastCalls = 0;
    let sessionMediaCount = 0;
    let sessionUserMediaCount = 0;
    let sessionToolMediaCount = 0;
    let prevSingleToolName = null;
    let prevPlannerMs = null;
    let prevTurnHadUserInputBetween = false;
    let prevTurnHadCalls = false;
    let prevCacheCtxTok = null;
    let prevCachePlannerMs = null;
    let prevCacheModel = null;
    let prevCacheHadCalls = false;
    let prevCacheHadBlockingTool = false;
    let prevCacheHadPlanSwitch = false;
    let betweenCacheUserInput = false;
    let betweenCacheSysMsg = false;
    let betweenCachePlanNotice = false;
    let betweenCacheError = false;
    let missStreak = 0;
    const flushMissStreak = () => {
      if (missStreak >= 3) {
        cacheMissAttribution.sustainedCollapseRuns += 1;
        cacheMissAttribution.sustainedCollapseTurns += missStreak;
      }
      missStreak = 0;
    };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (Array.isArray(step.media) && step.media.length > 0) {
        sessionMediaCount += step.media.length;
        if (step.type === "USER_INPUT") {
          sessionUserMediaCount += step.media.length;
        } else {
          sessionToolMediaCount += step.media.length;
        }
      }
      if (step.type === "USER_INPUT") {
        prevSingleToolName = null;
        prevTurnHadUserInputBetween = true;
        prevTurnHadCalls = false;
        betweenCacheUserInput = true;
        continue;
      }
      if (step.type === "SYSTEM_MESSAGE") {
        betweenCacheSysMsg = true;
        if (typeof step.content === "string" && PLAN_MODE_NOTICE_RE.test(step.content)) {
          betweenCachePlanNotice = true;
        }
        if (!prevTurnHadCalls) {
          prevSingleToolName = null;
          prevTurnHadUserInputBetween = true;
        }
        continue;
      }
      if (step.type === "ERROR_MESSAGE") {
        betweenCacheError = true;
        continue;
      }
      if (step.type !== "PLANNER_RESPONSE") continue;
      hasPlanner = true;
      llmTurns += 1;
      const tPlanner = parseTimeMs(step.created_at);
      if (prevPlannerMs !== null && tPlanner !== null && !prevTurnHadUserInputBetween) {
        const gapSec = (tPlanner - prevPlannerMs) / 1e3;
        if (gapSec >= 0 && gapSec <= 3600) {
          turnGapsTotal += 1;
          if (gapSec > 60) turnGapsOver60s += 1;
        }
      }
      prevTurnHadUserInputBetween = false;
      if (tPlanner !== null) prevPlannerMs = tPlanner;
      const outTok = Number(step.output_tokens ?? 0);
      if (Number.isFinite(outTok) && outTok > 0) {
        totalOutputTokens += outTok;
      }
      const inTok = Number(step.input_tokens ?? 0);
      const cacheTok = Number(step.cache_read_tokens ?? 0);
      const safeInTok = Number.isFinite(inTok) && inTok > 0 ? inTok : 0;
      const safeCacheTok = Number.isFinite(cacheTok) && cacheTok > 0 ? cacheTok : 0;
      const ctxTok = safeInTok + safeCacheTok;
      const curModel = typeof step.model === "string" && step.model.trim() ? step.model.trim() : null;
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      const hasBlockingTool = calls.some(
        (c) => typeof c.name === "string" && BLOCKING_TOOLS.has(c.name)
      );
      const hasPlanModeTool = calls.some(
        (c) => typeof c.name === "string" && PLAN_MODE_TOOLS.has(c.name)
      );
      if (ctxTok > 0) {
        contextSum += ctxTok;
        contextCount += 1;
        if (ctxTok >= 15e4) over150kCount += 1;
        if (sessionMediaCount > 0 && ctxTok >= 18e4) {
          multimodalHighCtxTurns += 1;
          if (sessionToolMediaCount > 0) {
            multimodalHighCtxToolTurns += 1;
          } else if (sessionUserMediaCount > 0) {
            multimodalHighCtxUserOnlyTurns += 1;
          }
        }
        if (ctxTok >= 1e4) {
          cacheHitSum += safeCacheTok / ctxTok;
          cacheHitCount += 1;
        }
        if (prevCacheCtxTok !== null) {
          const isCompacted = prevCacheCtxTok >= 3e4 && ctxTok < prevCacheCtxTok * 0.78;
          if (isCompacted) {
            flushMissStreak();
            cacheMissAttribution.compactionResets += 1;
          } else if (prevCacheCtxTok >= 1e4 && ctxTok >= 1e4) {
            const hitRate = safeCacheTok / ctxTok;
            const retainedRatio = safeCacheTok / prevCacheCtxTok;
            if (hitRate < 0.5 && retainedRatio < 0.75) {
              cacheMissAttribution.total += 1;
              missStreak += 1;
              if (missStreak > cacheMissAttribution.maxConsecutiveMisses) {
                cacheMissAttribution.maxConsecutiveMisses = missStreak;
              }
              const rawGapSec = prevCachePlannerMs !== null && tPlanner !== null ? (tPlanner - prevCachePlannerMs) / 1e3 : null;
              const validGapSec = rawGapSec !== null && rawGapSec >= 0 ? rawGapSec : null;
              if (prevCacheHadPlanSwitch || betweenCachePlanNotice) {
                cacheMissAttribution.planModeSwitch += 1;
              } else if (prevCacheModel && curModel && prevCacheModel !== curModel) {
                cacheMissAttribution.modelSwitch += 1;
              } else if (betweenCacheError) {
                cacheMissAttribution.errorRetry += 1;
              } else if (validGapSec !== null && validGapSec >= 60) {
                if (betweenCacheUserInput || !prevCacheHadCalls || prevCacheHadBlockingTool) {
                  cacheMissAttribution.idleOrWaitGap += 1;
                } else {
                  cacheMissAttribution.activeSlowGap += 1;
                }
              } else if (!prevCacheHadCalls && (betweenCacheSysMsg || betweenCacheUserInput)) {
                cacheMissAttribution.asyncWakeupFast += 1;
              } else {
                cacheMissAttribution.fastReplicaOrPrefixMiss += 1;
              }
            } else {
              flushMissStreak();
              if (hitRate < 0.5 && retainedRatio >= 0.75) {
                cacheMissAttribution.contextDilutionTurns += 1;
              }
            }
          } else {
            flushMissStreak();
          }
        }
        prevCacheCtxTok = ctxTok;
        prevCachePlannerMs = tPlanner;
        prevCacheModel = curModel;
        prevCacheHadCalls = calls.length > 0;
        prevCacheHadBlockingTool = hasBlockingTool;
        prevCacheHadPlanSwitch = hasPlanModeTool;
        betweenCacheUserInput = false;
        betweenCacheSysMsg = false;
        betweenCachePlanNotice = false;
        betweenCacheError = step.status === "ERROR";
      } else if (step.status === "ERROR") {
        betweenCacheError = true;
      } else {
        flushMissStreak();
        prevCacheCtxTok = null;
        prevCachePlannerMs = null;
        prevCacheModel = null;
        prevCacheHadCalls = false;
        prevCacheHadBlockingTool = false;
        prevCacheHadPlanSwitch = false;
        betweenCacheUserInput = false;
        betweenCacheSysMsg = false;
        betweenCachePlanNotice = false;
        betweenCacheError = false;
      }
      const agyCallsThisTurn = [];
      let turnCorruptedAgyCalls = 0;
      if (calls.length > 0) {
        toolTurns += 1;
        totalToolCalls += calls.length;
        if (calls.length === 1) {
          singleToolTurns += 1;
          const singleName = calls[0] ? getCanonicalToolName(calls[0]) : "";
          if (singleName && singleName === prevSingleToolName) {
            consecutiveSingleChainsExtraTurns += 1;
          }
          prevSingleToolName = singleName || null;
        } else {
          prevSingleToolName = null;
        }
        const editedFilesThisTurn = /* @__PURE__ */ new Map();
        const agyToolsThisTurn = /* @__PURE__ */ new Map();
        let mcpCallsThisTurn = 0;
        let runCmdCallsThisTurn = 0;
        for (let callIdx = 0; callIdx < calls.length; callIdx++) {
          const call = calls[callIdx];
          const name = call.name ?? "";
          const callArgs = getCallArgs(call);
          if (name === "edit_file") {
            editFileCalls += 1;
            totalLogicalOps += 1;
            const p = getTargetPath(callArgs);
            if (p) {
              const cnt = (editedFilesThisTurn.get(p) ?? 0) + 1;
              editedFilesThisTurn.set(p, cnt);
              if (cnt > 1) redundantSameTurnEditFileCalls += 1;
            }
          } else if (name === "run_command") {
            const cmd = getCommandString(callArgs);
            const cliInv = extractAgyFastCliInvocation(cmd);
            if (cliInv && agyFastToolCalls[cliInv.tool] !== void 0) {
              const cliFastTool = cliInv.tool;
              agyFastToolCalls[cliFastTool] = (agyFastToolCalls[cliFastTool] ?? 0) + 1;
              agyCliCalls += 1;
              sessionFastCalls += 1;
              mcpCallsThisTurn += 1;
              agyToolsThisTurn.set(
                cliFastTool,
                (agyToolsThisTurn.get(cliFastTool) ?? 0) + 1
              );
              agyCallsThisTurn.push({ callIdx, call, fastTool: cliFastTool });
              const rcInfo = cliFastTool === "run_checks" ? inspectCliRunChecks(cliInv.args) : void 0;
              if (rcInfo) {
                if (rcInfo.isFullMode) runChecksFullModeCalls += 1;
                if (rcInfo.isSingleCommand) runChecksSingleCommandCalls += 1;
              }
              const cliOps = countCliLogicalOps(cliInv, rcInfo);
              agyFastLogicalOps += cliOps;
              totalLogicalOps += cliOps;
            } else {
              runCommandCalls += 1;
              runCmdCallsThisTurn += 1;
              totalLogicalOps += 1;
              if (isReadonlySearchShell(cmd)) {
                readonlySearchRunCommandCalls += 1;
              }
            }
          } else {
            const fastTool = extractAgyFastToolName(call);
            if (fastTool && agyFastToolCalls[fastTool] !== void 0) {
              agyFastToolCalls[fastTool] = (agyFastToolCalls[fastTool] ?? 0) + 1;
              if (name === "call_mcp_tool") {
                agyLazyCalls += 1;
              } else {
                agyEagerCalls += 1;
              }
              sessionFastCalls += 1;
              mcpCallsThisTurn += 1;
              agyToolsThisTurn.set(fastTool, (agyToolsThisTurn.get(fastTool) ?? 0) + 1);
              agyCallsThisTurn.push({ callIdx, call, fastTool });
              const corrupted = hasCorruptedAgyFastArgs(call, fastTool);
              if (corrupted) {
                agyCorruptedArgCalls += 1;
                turnCorruptedAgyCalls += 1;
              }
              const inner = extractAgyFastInnerArgs(call);
              if (fastTool === "run_checks") {
                const rcInfo = inspectMcpRunChecks(inner, corrupted);
                if (rcInfo.isFullMode) runChecksFullModeCalls += 1;
                if (rcInfo.isSingleCommand) runChecksSingleCommandCalls += 1;
              }
              const ops = countMcpLogicalOps(fastTool, inner, corrupted);
              agyFastLogicalOps += ops;
              totalLogicalOps += ops;
            } else {
              totalLogicalOps += 1;
            }
          }
        }
        if (mcpCallsThisTurn >= 2) {
          multiMcpTurns += 1;
          let hasSameToolDuplicate = false;
          for (const cnt of agyToolsThisTurn.values()) {
            if (cnt >= 2) {
              hasSameToolDuplicate = true;
              break;
            }
          }
          if (hasSameToolDuplicate) {
            multiSameMcpTurns += 1;
          } else {
            multiDiffMcpTurns += 1;
          }
        }
        if (runCmdCallsThisTurn >= 2) multiRunCommandTurns += 1;
      } else {
        prevSingleToolName = null;
      }
      prevTurnHadCalls = calls.length > 0;
      const genericTimes = [];
      const genericSteps = [];
      let nextPlannerMs = null;
      for (let j = i + 1; j < steps.length; j++) {
        const nxt = steps[j];
        if (nxt.type === "USER_INPUT") break;
        if (nxt.type === "SYSTEM_MESSAGE" && calls.length === 0) break;
        if (nxt.type === "PLANNER_RESPONSE") {
          nextPlannerMs = parseTimeMs(nxt.created_at);
          break;
        }
        if (nxt.type === "GENERIC") {
          genericSteps.push(nxt);
          const gt = parseTimeMs(nxt.created_at);
          if (gt !== null) genericTimes.push(gt);
        }
      }
      if (agyCallsThisTurn.length > 0) {
        const callIds = /* @__PURE__ */ new Set();
        for (const c of calls) {
          const cid = getToolCallId(c);
          if (cid !== null) callIds.add(cid);
        }
        const genericById = /* @__PURE__ */ new Map();
        const genericByIndex = /* @__PURE__ */ new Map();
        let anyGenericHasExplicitCallId = false;
        let anyGenericMatchesCallId = false;
        for (const gs of genericSteps) {
          if (typeof gs.tool_call_id === "string" && gs.tool_call_id.trim().length > 0 || typeof gs.call_id === "string" && gs.call_id.trim().length > 0) {
            anyGenericHasExplicitCallId = true;
          }
          const gid = getToolCallId(gs);
          if (gid !== null) {
            if (!genericById.has(gid)) genericById.set(gid, gs);
            if (callIds.has(gid)) anyGenericMatchesCallId = true;
          }
          if (typeof gs.step_index === "number" && Number.isInteger(gs.step_index)) {
            if (!genericByIndex.has(gs.step_index)) {
              genericByIndex.set(gs.step_index, gs);
            }
          }
        }
        const anyGenericHasToolCallId = anyGenericHasExplicitCallId || anyGenericMatchesCallId;
        for (const { callIdx, call, fastTool } of agyCallsThisTurn) {
          const resStep = pairToolCallResult(
            step,
            call,
            callIdx,
            calls.length,
            genericSteps,
            genericById,
            genericByIndex,
            anyGenericHasToolCallId
          );
          if (!resStep) {
            agyUnpairedResultCalls += 1;
            continue;
          }
          const resText = typeof resStep.content === "string" ? resStep.content : "";
          const rawBody = stripHostMetadataPrefix(resText);
          let cliExitCode = null;
          let body = rawBody;
          if ((call.name ?? "") === "run_command") {
            const exitMatch = /^Command exited with code (\d+)\.\s*(?:\r?\n)+(?:Command output:\r?\n)?/.exec(
              rawBody
            );
            if (exitMatch) {
              cliExitCode = Number.parseInt(exitMatch[1], 10);
              body = rawBody.slice(exitMatch[0].length);
            }
          }
          const isSpill = isHostSpillBody(body);
          if (isSpill) {
            mcpSpillCalls += 1;
          } else {
            if (AGY_BUDGET_TRUNCATED_RE.test(body)) {
              agyTruncatedCalls += 1;
            }
            if (AGY_MAX_RESULTS_CAPPED_RE.test(body)) {
              agyMaxResultsCappedCalls += 1;
            }
          }
          const isVerifyFailure = fastTool === "apply_edits" && !isSpill && AGY_VERIFY_FAILED_RE.test(body);
          const isNormalFailedCheckRun = fastTool === "run_checks" && cliExitCode !== null && cliExitCode !== 0 && /^Checks:\s+\d+\/\d+\s+passed,/.test(body);
          const isCliError = cliExitCode !== null && cliExitCode !== 0 && !isVerifyFailure && !isNormalFailedCheckRun;
          const isError = resStep.status === "ERROR" || resStep.status === "INVALID" || isCliError || AGY_ERROR_HEAD_RE.test(body) || (call.name ?? "") === "run_command" && !isVerifyFailure && !isNormalFailedCheckRun && /^Error:/.test(body);
          if (isError) {
            agyErrorCalls += 1;
          } else if (isVerifyFailure) {
            agyVerifyFailedCalls += 1;
          }
        }
      }
      let turnActiveSec = 0;
      if (tPlanner !== null && !hasBlockingTool) {
        if (genericTimes.length > 0) {
          let firstGeneric = genericTimes[0];
          let lastGeneric = genericTimes[0];
          for (let k = 1; k < genericTimes.length; k++) {
            const gt = genericTimes[k];
            if (gt < firstGeneric) firstGeneric = gt;
            if (gt > lastGeneric) lastGeneric = gt;
          }
          const llmSec = Math.max(0, (firstGeneric - tPlanner) / 1e3);
          const spreadSec = Math.max(0, (lastGeneric - firstGeneric) / 1e3);
          const execSec = nextPlannerMs !== null ? Math.max(0, (nextPlannerMs - lastGeneric) / 1e3) : 0;
          if (llmSec <= 600) {
            llmTimeSec += llmSec;
            activeTimeSec += llmSec;
            turnActiveSec += llmSec;
          }
          if (spreadSec <= 600) {
            streamWaitSec += spreadSec;
            activeTimeSec += spreadSec;
            turnActiveSec += spreadSec;
          }
          if (execSec <= 600) {
            toolExecTimeSec += execSec;
            activeTimeSec += execSec;
            turnActiveSec += execSec;
          }
        } else if (nextPlannerMs !== null) {
          const spanSec = Math.max(0, (nextPlannerMs - tPlanner) / 1e3);
          if (spanSec <= 600) {
            llmTimeSec += spanSec;
            activeTimeSec += spanSec;
            turnActiveSec += spanSec;
          }
        }
      }
      if (turnCorruptedAgyCalls > 0) {
        agyCorruptedArgWastedSec += turnActiveSec;
        if (Number.isFinite(outTok) && outTok > 0) {
          agyCorruptedArgWastedOutTokens += outTok;
        }
      }
    }
    flushMissStreak();
    if (hasPlanner) {
      validSessions += 1;
      mediaLoadedCount += sessionMediaCount;
      userMediaCount += sessionUserMediaCount;
      toolMediaCount += sessionToolMediaCount;
      if (sessionFastCalls > 0) sessionsWithAgyFast += 1;
      if (sessionHasStartupSnapshot(steps)) sessionsWithSnapshot += 1;
      const sessionKind = classifySessionKind(steps);
      if (sessionKind === "swarm") {
        swarmWorkerSessions += 1;
        if (sessionFastCalls > 0) swarmWorkerSessionsWithAgyFast += 1;
      } else if (sessionKind === "subagent") {
        subagentSessions += 1;
      } else {
        mainSessions += 1;
      }
    }
  }
  const fastTotal = Object.values(agyFastToolCalls).reduce((a, b) => a + b, 0);
  return {
    sessions: validSessions,
    mainSessions,
    subagentSessions,
    sessionsWithAgyFast,
    sessionsWithSnapshot,
    llmTurns,
    toolTurns,
    totalToolCalls,
    totalLogicalOps,
    agyFastLogicalOps,
    avgAgyFastPacking: fastTotal > 0 ? round2(agyFastLogicalOps / fastTotal) : 0,
    turnsPer10LogicalOps: totalLogicalOps > 0 ? round2(llmTurns / totalLogicalOps * 10) : 0,
    singleToolTurnRatio: toolTurns > 0 ? singleToolTurns / toolTurns : 0,
    consecutiveSingleChainsExtraTurns,
    activeTimeSec: round2(activeTimeSec),
    llmTimeSec: round2(llmTimeSec),
    streamWaitSec: round2(streamWaitSec),
    toolExecTimeSec: round2(toolExecTimeSec),
    totalOutputTokens,
    effectiveTps: activeTimeSec > 0 ? round2(totalOutputTokens / activeTimeSec) : 0,
    editFileCalls,
    redundantSameTurnEditFileCalls,
    runCommandCalls,
    readonlySearchRunCommandCalls,
    agyFastToolCalls,
    agyEagerCalls,
    agyLazyCalls,
    agyCliCalls,
    runChecksFullModeCalls,
    runChecksSingleCommandCalls,
    mcpSpillCalls,
    agyTruncatedCalls,
    agyMaxResultsCappedCalls,
    agyErrorCalls,
    agyVerifyFailedCalls,
    agyUnpairedResultCalls,
    agyCorruptedArgCalls,
    agyCorruptedArgWastedSec: round2(agyCorruptedArgWastedSec),
    agyCorruptedArgWastedOutTokens,
    swarmWorkerSessions,
    swarmWorkerSessionsWithAgyFast,
    multiMcpTurns,
    multiSameMcpTurns,
    multiDiffMcpTurns,
    multiRunCommandTurns,
    mediaLoadedCount,
    userMediaCount,
    toolMediaCount,
    multimodalHighCtxTurns,
    multimodalHighCtxUserOnlyTurns,
    multimodalHighCtxToolTurns,
    avgContextTokens: contextCount > 0 ? Math.round(contextSum / contextCount) : 0,
    over150kContextRatio: contextCount > 0 ? over150kCount / contextCount : 0,
    avgCacheHitRate: cacheHitCount > 0 ? cacheHitSum / cacheHitCount : 0,
    over60sGapRatio: turnGapsTotal > 0 ? turnGapsOver60s / turnGapsTotal : 0,
    cacheMissAttribution
  };
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function pct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}
var ALWAYS_SKIP_DIRS = /* @__PURE__ */ new Set(["chunks", "node_modules", ".git"]);
var BRAIN_SKIP_DIRS = /* @__PURE__ */ new Set([
  "scratch",
  "swarm",
  "media",
  ".tempmediaStorage",
  ".user_uploaded",
  "browser_sandbox",
  "browser_evidence"
]);
var SYSTEM_GENERATED_SKIP_DIRS = /* @__PURE__ */ new Set(["steps", "messages", "tasks"]);
function isBrainPath(target) {
  const parts = target.split(/[\\/]+/);
  return parts.includes(".system_generated") || parts.includes("brain");
}
async function collectTranscriptFiles(inputs) {
  const found = [];
  const seenRealFiles = /* @__PURE__ */ new Set();
  const visitedRealDirs = /* @__PURE__ */ new Set();
  async function recordFile(filePath) {
    let key;
    try {
      key = await fs.realpath(filePath);
    } catch {
      key = path.resolve(filePath);
    }
    if (seenRealFiles.has(key)) return;
    seenRealFiles.add(key);
    found.push(filePath);
  }
  async function walk(target, depth = 0, inBrainLayout = false) {
    if (depth > 10) return;
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (target.endsWith(".jsonl")) await recordFile(target);
      return;
    }
    if (!stat.isDirectory()) return;
    let realDir;
    try {
      realDir = await fs.realpath(target);
    } catch {
      realDir = path.resolve(target);
    }
    if (visitedRealDirs.has(realDir)) return;
    visitedRealDirs.add(realDir);
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    const resolvedEntries = [];
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        resolvedEntries.push({
          name: entry.name,
          fullPath,
          isDir: true,
          isFile: false
        });
      } else if (entry.isFile()) {
        resolvedEntries.push({
          name: entry.name,
          fullPath,
          isDir: false,
          isFile: true
        });
      } else if (entry.isSymbolicLink()) {
        try {
          const linkStat = await fs.stat(fullPath);
          resolvedEntries.push({
            name: entry.name,
            fullPath,
            isDir: linkStat.isDirectory(),
            isFile: linkStat.isFile()
          });
        } catch {
        }
      }
    }
    const dirNames = new Set(
      resolvedEntries.filter((e) => e.isDir).map((e) => e.name)
    );
    const fileNames = new Set(
      resolvedEntries.filter((e) => e.isFile).map((e) => e.name)
    );
    const isSystemGeneratedDir = path.basename(target) === ".system_generated";
    const hasSystemGeneratedChild = dirNames.has(".system_generated");
    const brainContext = inBrainLayout || isSystemGeneratedDir || hasSystemGeneratedChild || isBrainPath(target);
    const hasFull = fileNames.has("transcript_full.jsonl");
    const hasBasic = fileNames.has("transcript.jsonl");
    if (hasFull) {
      await recordFile(path.join(target, "transcript_full.jsonl"));
    } else if (hasBasic) {
      await recordFile(path.join(target, "transcript.jsonl"));
    }
    for (const entry of resolvedEntries) {
      if (entry.isDir) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (brainContext && BRAIN_SKIP_DIRS.has(entry.name)) continue;
        if (hasSystemGeneratedChild && entry.name !== ".system_generated") {
          continue;
        }
        if (isSystemGeneratedDir && SYSTEM_GENERATED_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        await walk(entry.fullPath, depth + 1, brainContext);
      } else if (entry.isFile && entry.name.endsWith(".jsonl") && entry.name !== "transcript_full.jsonl" && entry.name !== "transcript.jsonl" && !brainContext && !hasFull && !hasBasic) {
        await recordFile(entry.fullPath);
      }
    }
  }
  for (const inp of inputs) {
    await walk(path.resolve(inp));
  }
  return found.sort();
}
var DEFAULT_TRANSCRIPT_READ_CONCURRENCY = 8;
var MAX_TRANSCRIPT_READ_CONCURRENCY = 32;
function formatReadErrorReason(err) {
  if (err && typeof err === "object") {
    const code = "code" in err && typeof err.code === "string" ? err.code : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (code && !msg.includes(code)) return `${code}: ${msg}`;
    return msg;
  }
  return String(err);
}
function normalizeReadConcurrency(concurrency) {
  if (concurrency === void 0) return DEFAULT_TRANSCRIPT_READ_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  return Math.min(concurrency, MAX_TRANSCRIPT_READ_CONCURRENCY);
}
async function sortFilesByRecentMtime(files, onSkipped) {
  const withMtime = [];
  const batchSize = 64;
  for (let i = 0; i < files.length; i += batchSize) {
    const slice = files.slice(i, i + batchSize);
    const results = await Promise.all(
      slice.map(async (file) => {
        try {
          const stat = await fs.stat(file);
          return { ok: true, file, mtimeMs: stat.mtimeMs };
        } catch (err) {
          return {
            ok: false,
            skipped: { path: file, reason: formatReadErrorReason(err) }
          };
        }
      })
    );
    for (const item of results) {
      if (item.ok) {
        withMtime.push({ file: item.file, mtimeMs: item.mtimeMs });
      } else {
        onSkipped?.(item.skipped);
      }
    }
  }
  withMtime.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
  return withMtime.map((x) => x.file);
}
async function loadSingleTranscriptFile(file, sinceMs, untilMs) {
  try {
    const { steps: rawSteps, malformedLines } = await parseTranscriptJsonlFileDetailed(file);
    if (rawSteps.length === 0 && malformedLines > 0) {
      return {
        kind: "skipped",
        skipped: {
          path: file,
          reason: `corrupted JSONL (0 valid steps, ${malformedLines} malformed line${malformedLines === 1 ? "" : "s"})`
        }
      };
    }
    const steps = filterStepsByTime(rawSteps, sinceMs, untilMs);
    if (!steps.some((s) => s.type === "PLANNER_RESPONSE")) {
      return { kind: "empty" };
    }
    return { kind: "session", steps, rawSteps };
  } catch (err) {
    return {
      kind: "skipped",
      skipped: {
        path: file,
        reason: formatReadErrorReason(err)
      }
    };
  }
}
async function loadSessionsFromFiles(orderedFiles, options = {}) {
  const { recent, sinceMs, untilMs, skippedFiles, onSkippedFile } = options;
  const concurrency = normalizeReadConcurrency(options.concurrency);
  const sessions = [];
  const recordOutcome = (outcome) => {
    if (outcome.kind === "skipped") {
      skippedFiles?.push(outcome.skipped);
      onSkippedFile?.(outcome.skipped);
      return;
    }
    if (outcome.kind === "session") {
      if (outcome.steps !== outcome.rawSteps) {
        fullSessionStepsMap.set(outcome.steps, outcome.rawSteps);
      }
      sessions.push(outcome.steps);
    }
  };
  if (recent !== void 0) {
    let cursor = 0;
    while (cursor < orderedFiles.length && sessions.length < recent) {
      const remaining = recent - sessions.length;
      const batchLen = Math.min(
        concurrency,
        remaining,
        orderedFiles.length - cursor
      );
      const batch = orderedFiles.slice(cursor, cursor + batchLen);
      cursor += batchLen;
      const outcomes2 = await Promise.all(
        batch.map((file) => loadSingleTranscriptFile(file, sinceMs, untilMs))
      );
      for (const outcome of outcomes2) {
        recordOutcome(outcome);
        if (sessions.length >= recent) break;
      }
    }
    return sessions;
  }
  if (orderedFiles.length === 0) return sessions;
  const outcomes = new Array(orderedFiles.length);
  let nextIdx = 0;
  const workerCount = Math.min(concurrency, orderedFiles.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= orderedFiles.length) break;
        outcomes[idx] = await loadSingleTranscriptFile(
          orderedFiles[idx],
          sinceMs,
          untilMs
        );
      }
    })
  );
  for (const outcome of outcomes) {
    if (outcome) recordOutcome(outcome);
  }
  return sessions;
}
async function loadFilteredSessions(inputs, options = {}) {
  const { recent, sinceMs, untilMs, skippedFiles, onSkippedFile } = options;
  if (recent !== void 0 && (!Number.isSafeInteger(recent) || recent < 1)) {
    throw new RangeError("recent must be a positive integer");
  }
  if (sinceMs !== void 0 && !Number.isFinite(sinceMs)) {
    throw new RangeError("sinceMs must be a valid finite timestamp");
  }
  if (untilMs !== void 0 && !Number.isFinite(untilMs)) {
    throw new RangeError("untilMs must be a valid finite timestamp");
  }
  if (sinceMs !== void 0 && untilMs !== void 0 && sinceMs > untilMs) {
    throw new RangeError("sinceMs must be less than or equal to untilMs");
  }
  normalizeReadConcurrency(options.concurrency);
  const files = await collectTranscriptFiles(inputs);
  const recordSkipped = (skipped) => {
    skippedFiles?.push(skipped);
    onSkippedFile?.(skipped);
  };
  const orderedFiles = recent !== void 0 ? await sortFilesByRecentMtime(files, recordSkipped) : files;
  return loadSessionsFromFiles(orderedFiles, options);
}
async function analyzePaths(inputs, options = {}) {
  const sessions = await loadFilteredSessions(inputs, options);
  return analyzeTranscriptSessions(sessions);
}
function splitSessionsByUsage(sessions) {
  const withFastSessions = [];
  const withoutFastSessions = [];
  for (const s of sessions) {
    if (sessionUsesAgyFast(s)) {
      withFastSessions.push(s);
    } else {
      withoutFastSessions.push(s);
    }
  }
  return {
    overall: analyzeTranscriptSessions(sessions),
    withAgyFast: analyzeTranscriptSessions(withFastSessions),
    withoutAgyFast: analyzeTranscriptSessions(withoutFastSessions)
  };
}
async function analyzePathsByUsage(inputs, options = {}) {
  const sessions = await loadFilteredSessions(inputs, options);
  const mainList = [];
  const subagentList = [];
  const swarmList = [];
  for (const s of sessions) {
    const kind = classifySessionKind(s);
    if (kind === "swarm") {
      swarmList.push(s);
    } else if (kind === "subagent") {
      subagentList.push(s);
    } else {
      mainList.push(s);
    }
  }
  return {
    ...splitSessionsByUsage(sessions),
    bySessionKind: {
      main: splitSessionsByUsage(mainList),
      subagent: splitSessionsByUsage(subagentList),
      swarm: splitSessionsByUsage(swarmList)
    }
  };
}
function formatRunChecksHygieneCell(m) {
  const rc = m.agyFastToolCalls.run_checks ?? 0;
  if (rc === 0) return "-";
  return `${m.runChecksFullModeCalls}/${rc} (${pct(m.runChecksFullModeCalls / rc)}) / ${m.runChecksSingleCommandCalls}/${rc} (${pct(m.runChecksSingleCommandCalls / rc)})`;
}
function formatLogicalOpsCell(m) {
  const fastTotal = Object.values(m.agyFastToolCalls).reduce((a, b) => a + b, 0);
  return fastTotal > 0 ? `${m.totalLogicalOps} (agy-fast: ${m.agyFastLogicalOps}, ${m.avgAgyFastPacking.toFixed(2)}x avg)` : `${m.totalLogicalOps}`;
}
function formatMetricsMarkdown(m) {
  const fastTotal = Object.values(m.agyFastToolCalls).reduce((a, b) => a + b, 0);
  const rcTotal = m.agyFastToolCalls.run_checks ?? 0;
  const editRedundancy = m.editFileCalls > 0 ? pct(m.redundantSameTurnEditFileCalls / m.editFileCalls) : "0.0%";
  const readonlyShellRatio = m.runCommandCalls > 0 ? pct(m.readonlySearchRunCommandCalls / m.runCommandCalls) : "0.0%";
  const multimodalCell = m.mediaLoadedCount > 0 ? `${m.multimodalHighCtxTurns} (tool:${m.multimodalHighCtxToolTurns}, user-only:${m.multimodalHighCtxUserOnlyTurns}; ${m.mediaLoadedCount} media: user:${m.userMediaCount}, tool:${m.toolMediaCount})` : `${m.multimodalHighCtxTurns} (${m.mediaLoadedCount} media)`;
  return [
    "# agy-fast Transcript Benchmark",
    "",
    "| Metric | Value |",
    "| :--- | ---: |",
    `| Sessions | ${m.sessions} |`,
    ...m.subagentSessions > 0 || m.swarmWorkerSessions > 0 ? [
      `| Session types (main / subagent / swarm) | ${m.mainSessions} / ${m.subagentSessions} / ${m.swarmWorkerSessions} |`
    ] : [],
    `| Sessions using agy-fast | ${m.sessionsWithAgyFast}/${m.sessions} (snapshot: ${m.sessionsWithSnapshot}) |`,
    `| LLM turns | ${m.llmTurns} |`,
    `| Tool calls | ${m.totalToolCalls} |`,
    `| Logical ops (agy-fast avg packing) | ${formatLogicalOpsCell(m)} |`,
    `| LLM turns / 10 logical ops | ${m.turnsPer10LogicalOps.toFixed(2)} |`,
    `| Active time (s) | ${m.activeTimeSec.toFixed(1)} |`,
    `| LLM wait & decode (s) | ${m.llmTimeSec.toFixed(1)} |`,
    `| Multi-tool stream buffer wait (s) | ${m.streamWaitSec.toFixed(1)} |`,
    `| Tool execution time (s) | ${m.toolExecTimeSec.toFixed(1)} |`,
    `| Effective throughput (tok/s) | ${m.effectiveTps.toFixed(1)} |`,
    `| Single-tool turn ratio | ${pct(m.singleToolTurnRatio)} |`,
    `| Consecutive same-tool extra turns | ${m.consecutiveSingleChainsExtraTurns} |`,
    `| Redundant same-turn edit_file ratio | ${editRedundancy} (${m.redundantSameTurnEditFileCalls}/${m.editFileCalls}) |`,
    `| Read-only search shell ratio | ${readonlyShellRatio} (${m.readonlySearchRunCommandCalls}/${m.runCommandCalls}) |`,
    `| Average context size (tokens) | ${m.avgContextTokens.toLocaleString("en-US")} |`,
    `| Turns >= 150k context | ${pct(m.over150kContextRatio)} |`,
    `| Average Prompt Cache hit rate | ${pct(m.avgCacheHitRate)} |`,
    `| Turn gaps > 60s | ${pct(m.over60sGapRatio)} |`,
    ...formatCacheMissRows(m.cacheMissAttribution),
    `| agy-fast tool calls | ${fastTotal} (search:${m.agyFastToolCalls.batch_search}, edit:${m.agyFastToolCalls.apply_edits}, slice:${m.agyFastToolCalls.read_slices}, outline:${m.agyFastToolCalls.quick_outline ?? 0}, check:${rcTotal}; eager:${m.agyEagerCalls}, lazy:${m.agyLazyCalls}${m.agyCliCalls > 0 ? `, cli:${m.agyCliCalls}` : ""}) |`,
    `| agy-fast health (spills / budget-truncs / max-results / errs / verify-fails) | ${m.mcpSpillCalls} / ${m.agyTruncatedCalls} / ${m.agyMaxResultsCappedCalls} / ${m.agyErrorCalls} / ${m.agyVerifyFailedCalls} |`,
    ...rcTotal > 0 ? [`| run_checks hygiene (full-mode / single-cmd) | ${formatRunChecksHygieneCell(m)} |`] : [],
    ...m.agyUnpairedResultCalls > 0 ? [`| agy-fast unpaired results | ${m.agyUnpairedResultCalls} |`] : [],
    ...m.agyCorruptedArgCalls > 0 ? [
      `| agy-fast corrupted-arg calls | ${m.agyCorruptedArgCalls} (wasted ${m.agyCorruptedArgWastedSec.toFixed(1)}s, ${m.agyCorruptedArgWastedOutTokens.toLocaleString("en-US")} out tok) |`
    ] : [],
    ...m.swarmWorkerSessions > 0 ? [
      `| Swarm worker coverage | ${m.swarmWorkerSessionsWithAgyFast}/${m.swarmWorkerSessions} using agy-fast |`
    ] : [],
    `| Parallel batching leaks (same-MCP (diff-MCP) / multi-run_command) | ${m.multiSameMcpTurns} (${m.multiDiffMcpTurns}) / ${m.multiRunCommandTurns} |`,
    `| Multimodal >=180k turns (media loaded) | ${multimodalCell} |`
  ].join("\n");
}
function formatCacheMissRows(a) {
  const rows = [];
  if (a.total > 0 || a.compactionResets > 0 || a.contextDilutionTurns > 0) {
    const extras = [];
    if (a.modelSwitch > 0) extras.push(`model:${a.modelSwitch}`);
    if (a.compactionResets > 0) extras.push(`compact:${a.compactionResets}`);
    if (a.contextDilutionTurns > 0) extras.push(`dilute:${a.contextDilutionTurns}`);
    const extraSuffix = extras.length > 0 ? `; ${extras.join(", ")}` : "";
    rows.push(
      `| Prompt Cache misses (active>=60s / idle>=60s / plan / err / async<60s / fast-other) | ${a.total} (${a.activeSlowGap} / ${a.idleOrWaitGap} / ${a.planModeSwitch} / ${a.errorRetry} / ${a.asyncWakeupFast} / ${a.fastReplicaOrPrefixMiss}${extraSuffix}) |`
    );
  }
  if (a.sustainedCollapseRuns > 0) {
    rows.push(
      `| Sustained cache collapse (>=3 consecutive misses) | ${a.sustainedCollapseRuns} runs (${a.sustainedCollapseTurns} turns, max streak: ${a.maxConsecutiveMisses}) |`
    );
  }
  return rows;
}
function formatDelta(before, after) {
  if (before === 0) return after === 0 ? "0.0%" : "n/a";
  const d = (after - before) / before * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}
function formatCompareMarkdown(before, after) {
  const showRunChecksHygiene = (before.agyFastToolCalls.run_checks ?? 0) > 0 || (after.agyFastToolCalls.run_checks ?? 0) > 0;
  const fmtCmpMultimodal = (m) => m.mediaLoadedCount > 0 ? `${m.multimodalHighCtxTurns} (tool:${m.multimodalHighCtxToolTurns}, user:${m.multimodalHighCtxUserOnlyTurns}; u${m.userMediaCount}/t${m.toolMediaCount})` : `${m.multimodalHighCtxTurns}`;
  return [
    "# agy-fast A/B Comparison",
    "",
    "| Metric | Before | After | Change |",
    "| :--- | ---: | ---: | ---: |",
    `| Sessions | ${before.sessions} | ${after.sessions} | - |`,
    `| LLM turns | ${before.llmTurns} | ${after.llmTurns} | ${formatDelta(before.llmTurns, after.llmTurns)} |`,
    `| Tool calls | ${before.totalToolCalls} | ${after.totalToolCalls} | ${formatDelta(before.totalToolCalls, after.totalToolCalls)} |`,
    `| Logical ops (agy-fast avg packing) | ${formatLogicalOpsCell(before)} | ${formatLogicalOpsCell(after)} | ${formatDelta(before.totalLogicalOps, after.totalLogicalOps)} |`,
    `| LLM turns / 10 logical ops | ${before.turnsPer10LogicalOps.toFixed(2)} | ${after.turnsPer10LogicalOps.toFixed(2)} | ${formatDelta(before.turnsPer10LogicalOps, after.turnsPer10LogicalOps)} |`,
    `| Active time (s) | ${before.activeTimeSec.toFixed(1)} | ${after.activeTimeSec.toFixed(1)} | ${formatDelta(before.activeTimeSec, after.activeTimeSec)} |`,
    `| Tool execution time (s) | ${before.toolExecTimeSec.toFixed(1)} | ${after.toolExecTimeSec.toFixed(1)} | ${formatDelta(before.toolExecTimeSec, after.toolExecTimeSec)} |`,
    `| Effective throughput (tok/s) | ${before.effectiveTps.toFixed(1)} | ${after.effectiveTps.toFixed(1)} | ${formatDelta(before.effectiveTps, after.effectiveTps)} |`,
    `| Single-tool turn ratio | ${pct(before.singleToolTurnRatio)} | ${pct(after.singleToolTurnRatio)} | ${formatDelta(before.singleToolTurnRatio, after.singleToolTurnRatio)} |`,
    `| Average context (tokens) | ${before.avgContextTokens} | ${after.avgContextTokens} | ${formatDelta(before.avgContextTokens, after.avgContextTokens)} |`,
    `| Prompt Cache hit rate | ${pct(before.avgCacheHitRate)} | ${pct(after.avgCacheHitRate)} | ${formatDelta(before.avgCacheHitRate, after.avgCacheHitRate)} |`,
    `| Turn gaps > 60s | ${pct(before.over60sGapRatio)} | ${pct(after.over60sGapRatio)} | ${formatDelta(before.over60sGapRatio, after.over60sGapRatio)} |`,
    ...before.cacheMissAttribution.total > 0 || after.cacheMissAttribution.total > 0 ? [
      `| Prompt Cache misses (non-compact) | ${before.cacheMissAttribution.total} | ${after.cacheMissAttribution.total} | ${formatDelta(before.cacheMissAttribution.total, after.cacheMissAttribution.total)} |`
    ] : [],
    ...before.cacheMissAttribution.sustainedCollapseRuns > 0 || after.cacheMissAttribution.sustainedCollapseRuns > 0 ? [
      `| Sustained cache collapse (>=3 misses) | ${before.cacheMissAttribution.sustainedCollapseRuns} runs (${before.cacheMissAttribution.sustainedCollapseTurns}t) | ${after.cacheMissAttribution.sustainedCollapseRuns} runs (${after.cacheMissAttribution.sustainedCollapseTurns}t) | - |`
    ] : [],
    `| agy-fast MCP spills (output.txt) | ${before.mcpSpillCalls} | ${after.mcpSpillCalls} | ${formatDelta(before.mcpSpillCalls, after.mcpSpillCalls)} |`,
    `| agy-fast budget truncations | ${before.agyTruncatedCalls} | ${after.agyTruncatedCalls} | ${formatDelta(before.agyTruncatedCalls, after.agyTruncatedCalls)} |`,
    `| agy-fast maxResults caps | ${before.agyMaxResultsCappedCalls} | ${after.agyMaxResultsCappedCalls} | ${formatDelta(before.agyMaxResultsCappedCalls, after.agyMaxResultsCappedCalls)} |`,
    `| agy-fast tool errors | ${before.agyErrorCalls} | ${after.agyErrorCalls} | ${formatDelta(before.agyErrorCalls, after.agyErrorCalls)} |`,
    `| agy-fast verify failures | ${before.agyVerifyFailedCalls} | ${after.agyVerifyFailedCalls} | ${formatDelta(before.agyVerifyFailedCalls, after.agyVerifyFailedCalls)} |`,
    ...showRunChecksHygiene ? [
      `| run_checks hygiene (full-mode / single-cmd) | ${formatRunChecksHygieneCell(before)} | ${formatRunChecksHygieneCell(after)} | - |`
    ] : [],
    before.agyCliCalls > 0 || after.agyCliCalls > 0 ? `| agy-fast dispatch (eager / lazy / cli) | ${before.agyEagerCalls} / ${before.agyLazyCalls} / ${before.agyCliCalls} | ${after.agyEagerCalls} / ${after.agyLazyCalls} / ${after.agyCliCalls} | - |` : `| agy-fast dispatch (eager / lazy) | ${before.agyEagerCalls} / ${before.agyLazyCalls} | ${after.agyEagerCalls} / ${after.agyLazyCalls} | - |`,
    `| Parallel leaks (same-MCP (diff-MCP) / multi-run_command) | ${before.multiSameMcpTurns} (${before.multiDiffMcpTurns}) / ${before.multiRunCommandTurns} | ${after.multiSameMcpTurns} (${after.multiDiffMcpTurns}) / ${after.multiRunCommandTurns} | - |`,
    `| Multimodal >=180k turns | ${fmtCmpMultimodal(before)} | ${fmtCmpMultimodal(after)} | ${formatDelta(before.multimodalHighCtxTurns, after.multimodalHighCtxTurns)} |`
  ].join("\n");
}
function formatUsageSplitMarkdown(split) {
  const { overall, withoutAgyFast: wo, withAgyFast: wf } = split;
  const editRed = (m) => m.editFileCalls > 0 ? m.redundantSameTurnEditFileCalls / m.editFileCalls : 0;
  const roShell = (m) => m.runCommandCalls > 0 ? m.readonlySearchRunCommandCalls / m.runCommandCalls : 0;
  const fastSum = (m) => Object.values(m.agyFastToolCalls).reduce((a, b) => a + b, 0);
  const hasMixedSessionKinds = overall.subagentSessions > 0 || overall.swarmWorkerSessions > 0;
  const fmtKinds = (m) => `${m.mainSessions} / ${m.subagentSessions} / ${m.swarmWorkerSessions}`;
  const fmtSplitMultimodal = (m) => m.mediaLoadedCount > 0 ? `${m.multimodalHighCtxTurns} (tool:${m.multimodalHighCtxToolTurns}, user:${m.multimodalHighCtxUserOnlyTurns}; u${m.userMediaCount}/t${m.toolMediaCount})` : `${m.multimodalHighCtxTurns} (${m.mediaLoadedCount})`;
  const lines = [
    "# agy-fast Usage Split Benchmark",
    "",
    "| Metric | Overall | Without agy-fast | With agy-fast | With vs Without |",
    "| :--- | ---: | ---: | ---: | ---: |",
    `| Sessions | ${overall.sessions} | ${wo.sessions} | ${wf.sessions} | - |`,
    ...hasMixedSessionKinds ? [
      `| Session types (main / subagent / swarm) | ${fmtKinds(overall)} | ${fmtKinds(wo)} | ${fmtKinds(wf)} | - |`
    ] : [],
    `| Sessions with snapshot | ${overall.sessionsWithSnapshot} | ${wo.sessionsWithSnapshot} | ${wf.sessionsWithSnapshot} | - |`,
    `| LLM turns | ${overall.llmTurns} | ${wo.llmTurns} | ${wf.llmTurns} | - |`,
    `| Tool calls | ${overall.totalToolCalls} | ${wo.totalToolCalls} | ${wf.totalToolCalls} | - |`,
    `| Logical ops (agy-fast avg packing) | ${formatLogicalOpsCell(overall)} | ${wo.totalLogicalOps} | ${formatLogicalOpsCell(wf)} | - |`,
    `| LLM turns / 10 logical ops | ${overall.turnsPer10LogicalOps.toFixed(2)} | ${wo.turnsPer10LogicalOps.toFixed(2)} | ${wf.turnsPer10LogicalOps.toFixed(2)} | ${formatDelta(wo.turnsPer10LogicalOps, wf.turnsPer10LogicalOps)} |`,
    `| Active time (s) | ${overall.activeTimeSec.toFixed(1)} | ${wo.activeTimeSec.toFixed(1)} | ${wf.activeTimeSec.toFixed(1)} | - |`,
    `| Multi-tool stream wait (s) | ${overall.streamWaitSec.toFixed(1)} | ${wo.streamWaitSec.toFixed(1)} | ${wf.streamWaitSec.toFixed(1)} | - |`,
    `| Effective throughput (tok/s) | ${overall.effectiveTps.toFixed(1)} | ${wo.effectiveTps.toFixed(1)} | ${wf.effectiveTps.toFixed(1)} | ${formatDelta(wo.effectiveTps, wf.effectiveTps)} |`,
    `| Single-tool turn ratio | ${pct(overall.singleToolTurnRatio)} | ${pct(wo.singleToolTurnRatio)} | ${pct(wf.singleToolTurnRatio)} | ${formatDelta(wo.singleToolTurnRatio, wf.singleToolTurnRatio)} |`,
    `| Redundant same-turn edit_file ratio | ${pct(editRed(overall))} | ${pct(editRed(wo))} | ${pct(editRed(wf))} | ${formatDelta(editRed(wo), editRed(wf))} |`,
    `| Read-only search shell ratio | ${pct(roShell(overall))} | ${pct(roShell(wo))} | ${pct(roShell(wf))} | ${formatDelta(roShell(wo), roShell(wf))} |`,
    `| Average context (tokens) | ${overall.avgContextTokens.toLocaleString("en-US")} | ${wo.avgContextTokens.toLocaleString("en-US")} | ${wf.avgContextTokens.toLocaleString("en-US")} | ${formatDelta(wo.avgContextTokens, wf.avgContextTokens)} |`,
    `| Prompt Cache hit rate | ${pct(overall.avgCacheHitRate)} | ${pct(wo.avgCacheHitRate)} | ${pct(wf.avgCacheHitRate)} | ${formatDelta(wo.avgCacheHitRate, wf.avgCacheHitRate)} |`,
    `| Turn gaps > 60s | ${pct(overall.over60sGapRatio)} | ${pct(wo.over60sGapRatio)} | ${pct(wf.over60sGapRatio)} | ${formatDelta(wo.over60sGapRatio, wf.over60sGapRatio)} |`,
    ...overall.cacheMissAttribution.total > 0 ? [
      `| Prompt Cache misses (non-compact) | ${overall.cacheMissAttribution.total} | ${wo.cacheMissAttribution.total} | ${wf.cacheMissAttribution.total} | ${formatDelta(wo.cacheMissAttribution.total, wf.cacheMissAttribution.total)} |`
    ] : [],
    ...overall.cacheMissAttribution.sustainedCollapseRuns > 0 ? [
      `| Sustained cache collapse (>=3 misses) | ${overall.cacheMissAttribution.sustainedCollapseRuns} runs (${overall.cacheMissAttribution.sustainedCollapseTurns}t) | ${wo.cacheMissAttribution.sustainedCollapseRuns} runs (${wo.cacheMissAttribution.sustainedCollapseTurns}t) | ${wf.cacheMissAttribution.sustainedCollapseRuns} runs (${wf.cacheMissAttribution.sustainedCollapseTurns}t) | - |`
    ] : [],
    `| agy-fast tool calls | ${fastSum(overall)} (eager:${overall.agyEagerCalls}, lazy:${overall.agyLazyCalls}${overall.agyCliCalls > 0 ? `, cli:${overall.agyCliCalls}` : ""}) | 0 | ${fastSum(wf)} (search:${wf.agyFastToolCalls.batch_search}, edit:${wf.agyFastToolCalls.apply_edits}, slice:${wf.agyFastToolCalls.read_slices}, outline:${wf.agyFastToolCalls.quick_outline ?? 0}, check:${wf.agyFastToolCalls.run_checks}; eager:${wf.agyEagerCalls}, lazy:${wf.agyLazyCalls}${wf.agyCliCalls > 0 ? `, cli:${wf.agyCliCalls}` : ""}) | - |`,
    `| agy-fast health (spills / budget-truncs / max-results / errs / verify-fails) | ${overall.mcpSpillCalls} / ${overall.agyTruncatedCalls} / ${overall.agyMaxResultsCappedCalls} / ${overall.agyErrorCalls} / ${overall.agyVerifyFailedCalls} | 0 / 0 / 0 / 0 / 0 | ${wf.mcpSpillCalls} / ${wf.agyTruncatedCalls} / ${wf.agyMaxResultsCappedCalls} / ${wf.agyErrorCalls} / ${wf.agyVerifyFailedCalls} | - |`,
    ...(overall.agyFastToolCalls.run_checks ?? 0) > 0 ? [
      `| run_checks hygiene (full-mode / single-cmd) | ${formatRunChecksHygieneCell(overall)} | - | ${formatRunChecksHygieneCell(wf)} | - |`
    ] : [],
    ...overall.agyUnpairedResultCalls > 0 ? [
      `| agy-fast unpaired results | ${overall.agyUnpairedResultCalls} | 0 | ${wf.agyUnpairedResultCalls} | - |`
    ] : [],
    ...overall.agyCorruptedArgCalls > 0 ? [
      `| agy-fast corrupted-arg calls | ${overall.agyCorruptedArgCalls} (${overall.agyCorruptedArgWastedSec.toFixed(1)}s) | 0 | ${wf.agyCorruptedArgCalls} (${wf.agyCorruptedArgWastedSec.toFixed(1)}s) | - |`
    ] : [],
    ...overall.swarmWorkerSessions > 0 ? [
      `| Swarm worker sessions | ${overall.swarmWorkerSessions} | ${wo.swarmWorkerSessions} | ${wf.swarmWorkerSessions} | - |`
    ] : [],
    `| Parallel leaks (same-MCP (diff-MCP) / multi-run_command) | ${overall.multiSameMcpTurns} (${overall.multiDiffMcpTurns}) / ${overall.multiRunCommandTurns} | ${wo.multiSameMcpTurns} (${wo.multiDiffMcpTurns}) / ${wo.multiRunCommandTurns} | ${wf.multiSameMcpTurns} (${wf.multiDiffMcpTurns}) / ${wf.multiRunCommandTurns} | - |`,
    `| Multimodal >=180k turns (media) | ${fmtSplitMultimodal(overall)} | ${fmtSplitMultimodal(wo)} | ${fmtSplitMultimodal(wf)} | - |`
  ];
  const mainSplit = split.bySessionKind?.main;
  if (hasMixedSessionKinds && mainSplit && mainSplit.overall.sessions > 0) {
    const mo = mainSplit.overall;
    const mwo = mainSplit.withoutAgyFast;
    const mwf = mainSplit.withAgyFast;
    lines.push(
      "",
      "## Main Sessions Only (Apples-to-Apples)",
      "",
      "| Metric | Overall | Without agy-fast | With agy-fast | With vs Without |",
      "| :--- | ---: | ---: | ---: | ---: |",
      `| Sessions | ${mo.sessions} | ${mwo.sessions} | ${mwf.sessions} | - |`,
      `| LLM turns | ${mo.llmTurns} | ${mwo.llmTurns} | ${mwf.llmTurns} | - |`,
      `| Logical ops (agy-fast avg packing) | ${formatLogicalOpsCell(mo)} | ${mwo.totalLogicalOps} | ${formatLogicalOpsCell(mwf)} | - |`,
      `| LLM turns / 10 logical ops | ${mo.turnsPer10LogicalOps.toFixed(2)} | ${mwo.turnsPer10LogicalOps.toFixed(2)} | ${mwf.turnsPer10LogicalOps.toFixed(2)} | ${formatDelta(mwo.turnsPer10LogicalOps, mwf.turnsPer10LogicalOps)} |`,
      `| Effective throughput (tok/s) | ${mo.effectiveTps.toFixed(1)} | ${mwo.effectiveTps.toFixed(1)} | ${mwf.effectiveTps.toFixed(1)} | ${formatDelta(mwo.effectiveTps, mwf.effectiveTps)} |`,
      `| Average context (tokens) | ${mo.avgContextTokens.toLocaleString("en-US")} | ${mwo.avgContextTokens.toLocaleString("en-US")} | ${mwf.avgContextTokens.toLocaleString("en-US")} | ${formatDelta(mwo.avgContextTokens, mwf.avgContextTokens)} |`,
      `| Prompt Cache hit rate | ${pct(mo.avgCacheHitRate)} | ${pct(mwo.avgCacheHitRate)} | ${pct(mwf.avgCacheHitRate)} | ${formatDelta(mwo.avgCacheHitRate, mwf.avgCacheHitRate)} |`,
      `| Turn gaps > 60s | ${pct(mo.over60sGapRatio)} | ${pct(mwo.over60sGapRatio)} | ${pct(mwf.over60sGapRatio)} | ${formatDelta(mwo.over60sGapRatio, mwf.over60sGapRatio)} |`
    );
  }
  return lines.join("\n");
}

// src/benchmark.ts
function warnSkippedFiles(skippedFiles) {
  if (skippedFiles.length === 0) return;
  const maxShown = 10;
  const lines = [
    `Warning: skipped ${skippedFiles.length} unreadable/corrupted transcript file(s):`
  ];
  for (const item of skippedFiles.slice(0, maxShown)) {
    lines.push(`  - ${item.path}: ${item.reason}`);
  }
  if (skippedFiles.length > maxShown) {
    lines.push(`  ... and ${skippedFiles.length - maxShown} more`);
  }
  process.stderr.write(`${lines.join("\n")}
`);
}
async function assertPathsExist(paths) {
  for (const p of paths) {
    try {
      await fs2.stat(path2.resolve(p));
    } catch {
      process.stderr.write(`Error: path does not exist: ${p}
`);
      return false;
    }
  }
  return true;
}
function parsePositiveInt(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}
function parseIsoTimestamp(raw, endOfDayIfDateOnly = false) {
  const trimmed = raw.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(trimmed)) return null;
  const normalized = endOfDayIfDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T23:59:59.999Z` : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
function getHomeDir(env = process.env) {
  return process.platform === "win32" ? env.USERPROFILE || env.HOME || os.homedir() : env.HOME || env.USERPROFILE || os.homedir();
}
async function discoverLocalBrainDirs(env = process.env) {
  const home = getHomeDir(env);
  const seen = /* @__PURE__ */ new Set();
  const dirs = [];
  const addDir = (p) => {
    const resolved = path2.resolve(p);
    const key = process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(resolved);
  };
  addDir(path2.join(home, ".gemini", "antigravity", "brain"));
  addDir(path2.join(home, ".gemini", "antigravity-cli", "brain"));
  addDir(path2.join(home, ".gemini", "antigravity-ide", "brain"));
  const addIfExistingDir = async (p) => {
    try {
      const st = await fs2.stat(p);
      if (st.isDirectory()) addDir(p);
    } catch {
    }
  };
  const t3ProvidersDir = path2.join(
    home,
    ".t3",
    "userdata",
    "providers",
    "antigravity"
  );
  try {
    const entries = await fs2.readdir(t3ProvidersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await addIfExistingDir(
        path2.join(t3ProvidersDir, entry.name, "antigravity-acp", "brain")
      );
    }
  } catch {
  }
  const envGeminiHome = env.GEMINI_HOME?.trim();
  if (envGeminiHome) {
    await addIfExistingDir(path2.join(envGeminiHome, "antigravity", "brain"));
    await addIfExistingDir(path2.join(envGeminiHome, "antigravity-acp", "brain"));
    await addIfExistingDir(path2.join(envGeminiHome, "antigravity-cli", "brain"));
    await addIfExistingDir(path2.join(envGeminiHome, "antigravity-ide", "brain"));
  }
  const envAppDataDir = env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envAppDataDir) {
    await addIfExistingDir(path2.join(envAppDataDir, "brain"));
  }
  return dirs;
}
function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node dist/benchmark.mjs analyze <path...> [--recent <N>] [--since <ISO>] [--until <ISO>] [--split-usage] [--json]",
      "  node dist/benchmark.mjs analyze --local [--recent <N>] [--since <ISO>] [--until <ISO>] [--split-usage] [--json]",
      "  node dist/benchmark.mjs compare --before <path> --after <path> [--json]",
      "",
      "Options:",
      "  --local        Scan local Antigravity brain dirs (Desktop 2.0, CLI, IDE, and ACP)",
      "  --recent <N>   Analyze only the N most recently modified transcripts",
      "  --since <ISO>  Include only steps at or after an ISO-8601 timestamp (e.g. 2026-11-19T12:51:00+08:00)",
      "  --until <ISO>  Include only steps at or before an ISO-8601 timestamp",
      "  --split-usage  Split metrics into sessions with vs. without agy-fast tool calls",
      "  --json         Output raw JSON metrics"
    ].join("\n") + "\n"
  );
}
async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }
  const cmd = args[0];
  if (cmd === "analyze") {
    const targets = [];
    const explicitTargets = [];
    let recent;
    let sinceMs;
    let untilMs;
    let splitUsage = false;
    let asJson = false;
    let afterDoubleDash = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (!afterDoubleDash && a === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && a === "--json") {
        asJson = true;
        continue;
      }
      if (!afterDoubleDash && a === "--split-usage") {
        splitUsage = true;
        continue;
      }
      if (!afterDoubleDash && a === "--local") {
        targets.push(...await discoverLocalBrainDirs());
        continue;
      }
      if (!afterDoubleDash && (a === "--recent" || a.startsWith("--recent="))) {
        const raw = a === "--recent" ? args[++i] : a.slice("--recent=".length);
        const parsed = raw !== void 0 ? parsePositiveInt(raw) : null;
        if (parsed === null) {
          process.stderr.write("Error: --recent must be a positive integer\n");
          process.exitCode = 1;
          return;
        }
        recent = parsed;
        continue;
      }
      if (!afterDoubleDash && (a === "--since" || a.startsWith("--since="))) {
        const raw = a === "--since" ? args[++i] : a.slice("--since=".length);
        const parsed = raw !== void 0 ? parseIsoTimestamp(raw) : null;
        if (parsed === null) {
          process.stderr.write("Error: --since must be a valid ISO-8601 date or timestamp\n");
          process.exitCode = 1;
          return;
        }
        sinceMs = parsed;
        continue;
      }
      if (!afterDoubleDash && (a === "--until" || a.startsWith("--until="))) {
        const raw = a === "--until" ? args[++i] : a.slice("--until=".length);
        const parsed = raw !== void 0 ? parseIsoTimestamp(raw, true) : null;
        if (parsed === null) {
          process.stderr.write("Error: --until must be a valid ISO-8601 date or timestamp\n");
          process.exitCode = 1;
          return;
        }
        untilMs = parsed;
        continue;
      }
      if (!afterDoubleDash && a.startsWith("-")) {
        process.stderr.write(`Error: unknown option: ${a}
`);
        process.exitCode = 1;
        return;
      }
      targets.push(a);
      explicitTargets.push(a);
    }
    if (targets.length === 0) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (sinceMs !== void 0 && untilMs !== void 0 && sinceMs > untilMs) {
      process.stderr.write("Error: --since must be earlier than or equal to --until\n");
      process.exitCode = 1;
      return;
    }
    if (explicitTargets.length > 0 && !await assertPathsExist(explicitTargets)) {
      process.exitCode = 1;
      return;
    }
    const skippedFiles = [];
    const opts = { skippedFiles };
    if (recent !== void 0) opts.recent = recent;
    if (sinceMs !== void 0) opts.sinceMs = sinceMs;
    if (untilMs !== void 0) opts.untilMs = untilMs;
    if (splitUsage) {
      const split = await analyzePathsByUsage(targets, opts);
      warnSkippedFiles(skippedFiles);
      process.stdout.write(
        asJson ? `${JSON.stringify(split, null, 2)}
` : `${formatUsageSplitMarkdown(split)}
`
      );
      return;
    }
    const metrics = await analyzePaths(targets, opts);
    warnSkippedFiles(skippedFiles);
    process.stdout.write(
      asJson ? `${JSON.stringify(metrics, null, 2)}
` : `${formatMetricsMarkdown(metrics)}
`
    );
    return;
  }
  if (cmd === "compare") {
    let beforePath = "";
    let afterPath = "";
    let asJson = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--json") {
        asJson = true;
      } else if (a === "--before" || a.startsWith("--before=")) {
        const val = a === "--before" ? args[++i] : a.slice("--before=".length);
        if (!val || a === "--before" && val.startsWith("-")) {
          process.stderr.write("Error: --before requires a path\n");
          process.exitCode = 1;
          return;
        }
        beforePath = val;
      } else if (a === "--after" || a.startsWith("--after=")) {
        const val = a === "--after" ? args[++i] : a.slice("--after=".length);
        if (!val || a === "--after" && val.startsWith("-")) {
          process.stderr.write("Error: --after requires a path\n");
          process.exitCode = 1;
          return;
        }
        afterPath = val;
      } else {
        process.stderr.write(`Error: unknown option: ${a}
`);
        process.exitCode = 1;
        return;
      }
    }
    if (!beforePath || !afterPath) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    if (!await assertPathsExist([beforePath, afterPath])) {
      process.exitCode = 1;
      return;
    }
    const beforeSkipped = [];
    const afterSkipped = [];
    const [before, after] = await Promise.all([
      analyzePaths([beforePath], { skippedFiles: beforeSkipped }),
      analyzePaths([afterPath], { skippedFiles: afterSkipped })
    ]);
    warnSkippedFiles([...beforeSkipped, ...afterSkipped]);
    process.stdout.write(
      asJson ? `${JSON.stringify({ before, after }, null, 2)}
` : `${formatCompareMarkdown(before, after)}
`
    );
    return;
  }
  printUsage();
  process.exitCode = 1;
}
void main(process.argv);
