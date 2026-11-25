import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

const WINDOWS_CODEPAGE_LABELS: Record<number, string> = {
  866: "ibm866",
  874: "windows-874",
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8",
};

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
let cachedWindowsFallbackEncoding: string | null | undefined;
const fallbackDecoderCache = new Map<string, TextDecoder>();

export function parseWindowsCodePage(output: string): string | null {
  const match = /\b(\d{3,5})\b/.exec(output);
  if (!match) return null;
  const cp = Number.parseInt(match[1]!, 10);
  const mapped = WINDOWS_CODEPAGE_LABELS[cp];
  return mapped && mapped !== "utf-8" ? mapped : null;
}

function stripTrailingIncompleteUtf8(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  const minIdx = Math.max(0, buf.length - 4);
  while (i >= minIdx && (buf[i]! & 0xc0) === 0x80) {
    i--;
  }
  if (i < minIdx) return buf;
  const lead = buf[i]!;
  if ((lead & 0x80) === 0) return buf;
  let expectedLen = 0;
  if ((lead & 0xe0) === 0xc0) expectedLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
  else return buf;
  return buf.length - i < expectedLen ? buf.subarray(0, i) : buf;
}

function getWindowsSystem32Binary(name: string): { bin: string; cwd: string } {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
  if (systemRoot) {
    return {
      bin: path.join(systemRoot, "System32", name),
      cwd: systemRoot,
    };
  }
  return { bin: name, cwd: process.cwd() };
}

function getWindowsFallbackEncoding(): string | null {
  if (cachedWindowsFallbackEncoding !== undefined) {
    return cachedWindowsFallbackEncoding;
  }
  try {
    const { bin: chcpBin, cwd } = getWindowsSystem32Binary("chcp.com");
    const res = spawnSync(chcpBin, [], {
      cwd,
      encoding: "latin1",
      timeout: 1500,
      windowsHide: true,
    });
    if (!res.error && res.status === 0) {
      const mapped = parseWindowsCodePage(res.stdout || "");
      if (mapped) {
        cachedWindowsFallbackEncoding = mapped;
        return cachedWindowsFallbackEncoding;
      }
    }
  } catch {
    // Ignore probe errors and fall back to UTF-8
  }
  cachedWindowsFallbackEncoding = null;
  return null;
}

/**
 * Decodes child-process stdout/stderr buffers as UTF-8 first, falling back to
 * the Windows active console codepage (e.g. `gb18030` for CP936) per line when
 * non-UTF-8 bytes are present so valid UTF-8 lines in mixed-encoding output do
 * not turn into mojibake.
 */
export function decodeProcessOutput(
  buf: Buffer,
  truncated = false,
  fallbackEncoding?: string,
): string {
  if (buf.length === 0) return "";
  const candidate = truncated ? stripTrailingIncompleteUtf8(buf) : buf;
  try {
    return strictUtf8Decoder.decode(candidate);
  } catch {
    const label =
      fallbackEncoding ??
      (process.platform === "win32" ? getWindowsFallbackEncoding() : null);
    if (!label || label === "utf-8") {
      return buf.toString("utf8");
    }
    let decoder: TextDecoder;
    try {
      const cached = fallbackDecoderCache.get(label);
      if (cached) {
        decoder = cached;
      } else {
        decoder = new TextDecoder(label);
        fallbackDecoderCache.set(label, decoder);
      }
    } catch {
      return buf.toString("utf8");
    }
    if (buf.indexOf(0x0a) === -1) {
      return decoder.decode(buf);
    }
    const parts: string[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      const end = nl === -1 ? buf.length : nl + 1;
      const line = buf.subarray(offset, end);
      const lineCandidate =
        truncated && end === buf.length ? stripTrailingIncompleteUtf8(line) : line;
      try {
        parts.push(strictUtf8Decoder.decode(lineCandidate));
      } catch {
        parts.push(decoder.decode(line));
      }
      offset = end;
    }
    return parts.join("");
  }
}

/**
 * agy aborts an MCP tool call after 180 s ("timed out after 3m0s") and drops
 * its result. All commands of one tool call share this budget; the remaining
 * 10 s cover the kill grace period below and response formatting.
 */
export const MCP_CALL_BUDGET_SEC = 170;

function killChildTree(pid: number | undefined, detached: boolean): NodeJS.Timeout | null {
  if (!pid) return null;
  if (process.platform === "win32") {
    const fallbackKill = (): void => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited
      }
    };
    try {
      const { bin: taskkillBin, cwd } = getWindowsSystem32Binary("taskkill.exe");
      const killer = spawn(taskkillBin, ["/PID", String(pid), "/T", "/F"], {
        cwd,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", fallbackKill);
      killer.unref();
    } catch {
      fallbackKill();
    }
    return null;
  }

  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process may already have exited
  }
  const sigkillTimer = setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Already exited
    }
  }, 400);
  sigkillTimer.unref();
  return sigkillTimer;
}

export function execBinaryAsync(
  bin: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return spawnAndCollect(bin, args, false, options);
}

export type WindowsPowerShellBin = "pwsh" | "powershell.exe";
export type WindowsShellProbe = (bin: WindowsPowerShellBin) => Promise<boolean>;

const WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE =
  /(?<![\\`])(?:\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE)\b)/i;
const WINDOWS_PS_UNQUOTED_SYNTAX_RE =
  /(?<![\\`])\$(?:HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/im;
const WINDOWS_PS_CMDLET_RE =
  /(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Z][A-Za-z0-9]*\b(?!-)/;
const EXPLICIT_POWERSHELL_INVOCATION_RE =
  /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;
const PS_NON_INVOCATION_TAIL_RE =
  /^(?:[|;&+}=),*?]|(?:[1-6*])?>|-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|replace|split|join|in|notin|contains|notcontains|is|isnot|as|and|or|xor|shl|shr|band|bor|bxor)\b|-f\b|$)/i;
const PS_UTF8_PREFIX =
  "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; $OutputEncoding = [System.Text.UTF8Encoding]::new($false);";

const WINDOWS_PS_WRAPPER_BIN_RE =
  /^(?:"(?:pwsh|powershell)(?:\.exe)?"|'(?:pwsh|powershell)(?:\.exe)?'|(?:pwsh|powershell)(?:\.exe)?)(?=\s)/i;

const WINDOWS_PS_BENIGN_FLAGS = new Set([
  "-noprofile",
  "-nop",
  "-noninteractive",
  "-noni",
  "-nologo",
  "-nol",
]);

const WINDOWS_UNWRAP_SAFE_BINS = new Set([
  "git",
  "rg",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "pytest",
  "uv",
  "ruff",
  "mypy",
  "flake8",
  "black",
  "go",
  "cargo",
  "rustc",
  "rustup",
  "java",
  "javac",
  "mvn",
  "gradle",
  "tsc",
  "tsx",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "biome",
  "dotnet",
  "cmake",
  "make",
  "ninja",
  "gcc",
  "g++",
  "clang",
  "gh",
  "docker",
  "kubectl",
  "terraform",
  "agy",
]);

const WINDOWS_UNWRAP_FORBIDDEN_META_RE =
  /[|;&><`$(){}@%!^*\r\n'#,?\[\]~\x00-\x08\x0b\x0c\x0e-\x1f\u0085\u00a0\u2013-\u2015\u2018-\u201f\u2028\u2029\u3000]/;

function hasSafeBalancedDoubleQuotes(text: string): boolean {
  if (/\\+"/.test(text)) return false;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') count++;
  }
  return count % 2 === 0;
}

/**
 * Unwraps trivial `powershell -Command "..."` / `pwsh -c "..."` wrappers around
 * single allowlisted cross-platform CLI binaries (e.g. `git`, `npm`, `node`,
 * `rg`, `pytest`, `cargo`) so Windows avoids paying PowerShell startup latency.
 *
 * PowerShell cmdlets, aliases (`del`, `rm`, `ls`, `echo`, `curl`, etc.), pipes,
 * redirections, variables, quoting edge cases, or non-benign PowerShell flags
 * are NEVER unwrapped so shell semantics remain 100% faithful.
 */
export function unwrapTrivialWindowsPowerShellCommand(command: string): string {
  const trimmed = command.trim();
  const binMatch = WINDOWS_PS_WRAPPER_BIN_RE.exec(trimmed);
  if (!binMatch) return command;

  let rest = trimmed.slice(binMatch[0].length);
  let sawCommandFlag = false;
  while (true) {
    rest = rest.trimStart();
    if (!rest) return command;
    const tokMatch = /^(\S+)/.exec(rest);
    if (!tokMatch) return command;
    const tok = tokMatch[1]!;
    const lower = tok.toLowerCase();
    rest = rest.slice(tok.length);
    if (lower === "-command" || lower === "-c") {
      if (!/^\s/.test(rest)) return command;
      sawCommandFlag = true;
      break;
    }
    if (!WINDOWS_PS_BENIGN_FLAGS.has(lower)) {
      return command;
    }
  }
  if (!sawCommandFlag) return command;

  const payload = rest.trim();
  if (!payload) return command;

  let inner: string;
  if (payload[0] === '"' || payload[0] === "'") {
    const quote = payload[0];
    if (payload.length < 2 || payload.indexOf(quote, 1) !== payload.length - 1) {
      return command;
    }
    const rawInner = payload.slice(1, -1);
    if (quote === '"' && rawInner.endsWith("\\")) {
      return command;
    }
    inner = rawInner.trim();
    if (quote === "'" && inner.includes('"') && !hasSafeBalancedDoubleQuotes(inner)) {
      return command;
    }
  } else {
    if (/^[-&./\\]/.test(payload)) return command;
    if (payload.includes('"') && !hasSafeBalancedDoubleQuotes(payload)) {
      return command;
    }
    inner = payload;
  }

  if (!inner || WINDOWS_UNWRAP_FORBIDDEN_META_RE.test(inner)) {
    return command;
  }

  const firstTok = /^(\S+)/.exec(inner)?.[1];
  if (!firstTok || !/^[A-Za-z0-9_+.-]+$/.test(firstTok)) {
    return command;
  }
  const baseBin = firstTok.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  if (!WINDOWS_UNWRAP_SAFE_BINS.has(baseBin)) {
    return command;
  }
  if (needsPowerShellOnWindows(inner)) {
    return command;
  }
  return inner;
}

function stripQuotedSpans(command: string, stripDoubleQuotes: boolean): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") {
        if (next === "'") {
          i++;
        } else {
          quote = null;
          out += " ";
        }
      }
      continue;
    }
    if (quote === '"') {
      if ((ch === "\\" || ch === "`") && (next === ch || next === '"')) {
        i++;
        if (!stripDoubleQuotes) out += ch + next;
        continue;
      }
      if (ch === '"') {
        if (next === '"') {
          i++;
          if (!stripDoubleQuotes) out += '""';
        } else {
          quote = null;
          out += stripDoubleQuotes ? " " : '"';
        }
        continue;
      }
      if (!stripDoubleQuotes) out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      out += " ";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      out += stripDoubleQuotes ? " " : '"';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Returns true only when `command` has an embedded line break AFTER stripping
 * leading/trailing whitespace so single-line commands with trailing `\n`/`\r\n`
 * keep fast `cmd.exe` execution on Windows.
 */
export function hasEmbeddedNewline(command: string): boolean {
  return /[\r\n]/.test(command.trim());
}

/**
 * Detects whether a Windows command uses PowerShell syntax (`$env:VAR`, automatic
 * variables, subexpressions, or PascalCase `Verb-Noun` cmdlets outside quotes)
 * so cross-platform/cmd commands keep fast `cmd.exe` execution without altering
 * quoting behavior.
 */
export function needsPowerShellOnWindows(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || EXPLICIT_POWERSHELL_INVOCATION_RE.test(trimmed)) {
    return false;
  }
  const withoutSingle = stripQuotedSpans(trimmed, false);
  if (WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE.test(withoutSingle)) {
    return true;
  }
  const unquoted = stripQuotedSpans(trimmed, true);
  return (
    WINDOWS_PS_UNQUOTED_SYNTAX_RE.test(unquoted) ||
    WINDOWS_PS_CMDLET_RE.test(unquoted)
  );
}

function formatSinglePowerShellLine(line: string): string {
  const leadMatch = /^([ \t]*)/.exec(line);
  const indent = leadMatch?.[1] ?? "";
  const trimmed = line.slice(indent.length);
  if (!trimmed || (trimmed[0] !== '"' && trimmed[0] !== "'")) {
    return line;
  }
  const quote = trimmed[0];
  let idx = 1;
  while (idx < trimmed.length) {
    if (quote === '"' && trimmed[idx] === "`" && idx + 1 < trimmed.length) {
      idx += 2;
      continue;
    }
    if (trimmed[idx] === quote) {
      // Both PowerShell '...' (`''`) and "..." (`""`) escape doubled quotes
      if (trimmed[idx + 1] === quote) {
        idx += 2;
        continue;
      }
      const afterQuote = trimmed.slice(idx + 1);
      if (!/^[ \t]+/.test(afterQuote)) {
        return line;
      }
      const rest = afterQuote.replace(/^[ \t]+/, "");
      if (rest && !/^[\r\n]/.test(rest) && !PS_NON_INVOCATION_TAIL_RE.test(rest)) {
        return `${indent}& ${trimmed}`;
      }
      return line;
    }
    idx++;
  }
  return line;
}

function advancePowerShellQuoteState(
  line: string,
  state: { quote: '"' | "'" | null; hereQuote: '"' | "'" | null },
): void {
  if (state.hereQuote) {
    const closeMarker = state.hereQuote === '"' ? '"@' : "'@";
    if (line.startsWith(closeMarker) && line.slice(2).trim() === "") {
      state.hereQuote = null;
    }
    return;
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (state.quote === "'") {
      if (ch === "'") {
        if (next === "'") i++;
        else state.quote = null;
      }
      continue;
    }
    if (state.quote === '"') {
      if (ch === "`" && next !== undefined) {
        i++;
        continue;
      }
      if (ch === '"') {
        if (next === '"') i++;
        else state.quote = null;
      }
      continue;
    }
    if (ch === "#") break;
    if (ch === "@" && (next === '"' || next === "'") && line.slice(i + 2).trim() === "") {
      state.hereQuote = next;
      return;
    }
    if (ch === "'" || ch === '"') {
      state.quote = ch;
    }
  }
}

/**
 * Prepends `&` when a PowerShell command (or any top-level line of a multiline
 * PowerShell script) starts with a quoted executable path followed by horizontal
 * whitespace + arguments (e.g. `"C:\Program Files\nodejs\node.exe" -v`), while
 * leaving PowerShell string expressions (`"$Env:PATH".Split(';')`, `"hello" \n...`,
 * `"$Env:FOO" > out.txt`, `'it''s' + $Env:FOO`, etc.) untouched.
 */
export function formatPowerShellCommand(command: string): string {
  if (!/[\r\n]/.test(command)) {
    const trimmed = command.trim();
    if (!trimmed || (trimmed[0] !== '"' && trimmed[0] !== "'")) {
      return command;
    }
    const formatted = formatSinglePowerShellLine(trimmed);
    return formatted === trimmed ? command : formatted;
  }

  const parts = command.split(/(\r\n|\n|\r)/);
  const state: { quote: '"' | "'" | null; hereQuote: '"' | "'" | null } = {
    quote: null,
    hereQuote: null,
  };
  let changed = false;
  const outParts: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    const formatted =
      state.quote === null && state.hereQuote === null
        ? formatSinglePowerShellLine(line)
        : line;
    if (formatted !== line) changed = true;
    outParts.push(formatted, sep);
    advancePowerShellQuoteState(line, state);
  }
  return changed ? outParts.join("") : command;
}

const PS_FAIL_FAST_STMT_CHECK =
  "$__agyOk = $?; $__agyCode = $LASTEXITCODE; if ($__agyCode -and $__agyCode -ne 0) { exit $__agyCode }; if (-not $__agyOk -and $null -eq $__agyCode) { exit 1 }; $global:LASTEXITCODE = $null";

const PS_LINE_CONTINUATION_TAIL_RE = /(?:`|\||,|&&|\|\||[{(=]|(?<!\+)\+)\s*$/;
const PS_NEXT_BLOCK_CONT_RE = /^\s*(?:[{}|]|else\b|elseif\b|catch\b|finally\b)/i;

/**
 * Wraps complete top-level statements in a multiline PowerShell script with a
 * fail-fast check that terminates on BOTH cmdlet errors (e.g. `Set-Location`
 * missing dir) and non-zero native `$LASTEXITCODE`, while staying safe on
 * Windows PowerShell 5.1 when native commands write benign warnings to stderr
 * and exit 0.
 */
export function wrapMultilinePowerShellFailFast(script: string): string {
  const lines = script.split(/\r?\n/);
  const state: { quote: '"' | "'" | null; hereQuote: '"' | "'" | null } = {
    quote: null,
    hereQuote: null,
  };
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  const out: string[] = ["$global:LASTEXITCODE = $null"];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInMultilineToken = state.quote !== null || state.hereQuote !== null;
    out.push(line);

    if (state.hereQuote) {
      advancePowerShellQuoteState(line, state);
      continue;
    }

    let codePart = "";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      const next = line[j + 1];
      if (state.quote === "'") {
        if (ch === "'") {
          if (next === "'") j++;
          else state.quote = null;
        }
        continue;
      }
      if (state.quote === '"') {
        if (ch === "`" && next !== undefined) {
          j++;
          continue;
        }
        if (ch === '"') {
          if (next === '"') j++;
          else state.quote = null;
        }
        continue;
      }
      if (ch === "#") break;
      if (ch === "@" && (next === '"' || next === "'") && line.slice(j + 2).trim() === "") {
        state.hereQuote = next;
        break;
      }
      if (ch === "'" || ch === '"') {
        state.quote = ch;
        codePart += " __STR__ ";
        continue;
      }
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      codePart += ch;
    }

    const trimmedCode = codePart.trim();
    if (!trimmedCode && !wasInMultilineToken) continue;
    if (
      state.quote !== null ||
      state.hereQuote !== null ||
      braceDepth > 0 ||
      parenDepth > 0 ||
      bracketDepth > 0
    ) {
      continue;
    }
    if (PS_LINE_CONTINUATION_TAIL_RE.test(trimmedCode)) continue;

    // Peek next non-empty, non-comment line for `else` / `catch` / `finally` / `}`
    let nextNonEmpty = "";
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trim();
      if (t && !t.startsWith("#")) {
        nextNonEmpty = t;
        break;
      }
    }
    if (nextNonEmpty && PS_NEXT_BLOCK_CONT_RE.test(nextNonEmpty)) continue;

    out.push(PS_FAIL_FAST_STMT_CHECK);
  }
  return out.join("\n");
}

export function buildPowerShellUtf8Command(command: string): string {
  const trimmed = command.trim();
  if (hasEmbeddedNewline(trimmed)) {
    const formatted = formatPowerShellCommand(trimmed);
    return `${PS_UTF8_PREFIX}\n${wrapMultilinePowerShellFailFast(formatted)}`;
  }
  return `${PS_UTF8_PREFIX} ${formatPowerShellCommand(command)}`;
}

/**
 * Encodes a PowerShell script as UTF-16LE Base64 for `-EncodedCommand`,
 * preserving embedded newlines and complex quoting across Windows CreateProcess.
 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

// Stay safely below Windows CreateProcess's 32,767-char command-line limit
export const MAX_PS_ENCODED_COMMAND_CHARS = 28_000;

export function buildWindowsPowerShellArgs(command: string): string[] {
  const utf8Command = buildPowerShellUtf8Command(command);
  if (hasEmbeddedNewline(command)) {
    return [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellCommand(utf8Command),
    ];
  }
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8Command];
}

const EXPLICIT_PS_VALUE_FLAGS = new Set(["-executionpolicy", "-ep"]);

export interface ParsedExplicitPowerShell {
  bin: string;
  flags: string[];
  script: string;
}

/**
 * Parses an explicit `pwsh`/`powershell` invocation containing `-Command`/`-c`
 * and embedded newlines so it can be executed directly with `shell: false` +
 * `-EncodedCommand` instead of falling through to `cmd.exe` and truncating.
 */
export function parseExplicitMultilinePowerShell(
  command: string,
): ParsedExplicitPowerShell | null {
  const trimmed = command.trim();
  if (!hasEmbeddedNewline(trimmed)) return null;
  const binMatch = WINDOWS_PS_WRAPPER_BIN_RE.exec(trimmed);
  if (!binMatch) return null;

  const rawBin = binMatch[0]!.trim();
  const bin =
    (rawBin.startsWith('"') && rawBin.endsWith('"')) ||
    (rawBin.startsWith("'") && rawBin.endsWith("'"))
      ? rawBin.slice(1, -1)
      : rawBin;

  let rest = trimmed.slice(binMatch[0]!.length);
  const flags: string[] = [];
  let sawCommandFlag = false;
  while (true) {
    rest = rest.trimStart();
    if (!rest) return null;
    const tokMatch = /^(\S+)/.exec(rest);
    if (!tokMatch) return null;
    const tok = tokMatch[1]!;
    const lower = tok.toLowerCase();
    rest = rest.slice(tok.length);
    if (lower === "-command" || lower === "-c") {
      if (!/^\s/.test(rest)) return null;
      sawCommandFlag = true;
      break;
    }
    if (WINDOWS_PS_BENIGN_FLAGS.has(lower)) {
      flags.push(tok);
      continue;
    }
    if (EXPLICIT_PS_VALUE_FLAGS.has(lower)) {
      rest = rest.trimStart();
      const valMatch = /^(\S+)/.exec(rest);
      if (!valMatch) return null;
      flags.push(tok, valMatch[1]!);
      rest = rest.slice(valMatch[1]!.length);
      continue;
    }
    return null;
  }
  if (!sawCommandFlag) return null;

  const payload = rest.trim();
  if (!payload) return null;

  let script = payload;
  if (payload[0] === '"' || payload[0] === "'") {
    const quote = payload[0];
    // Ensure outer quotes wrap the entire payload with no trailing outer shell operators
    let idx = 1;
    let closedAt = -1;
    while (idx < payload.length) {
      if (quote === '"' && (payload[idx] === "`" || payload[idx] === "\\") && payload[idx + 1] === '"') {
        idx += 2;
        continue;
      }
      if (payload[idx] === quote) {
        if (payload[idx + 1] === quote) {
          idx += 2;
          continue;
        }
        closedAt = idx;
        break;
      }
      idx++;
    }
    if (closedAt !== payload.length - 1) return null;
    script = payload.slice(1, -1);
    if (quote === "'") {
      script = script.replace(/''/g, "'");
    } else {
      script = script.replace(/\\"/g, '"');
    }
  }

  return { bin, flags, script };
}

/**
 * Checks whether a command contains an embedded newline INSIDE a quoted string
 * (e.g. `node -e "\nconsole.log(1);\n"`) as opposed to newlines separating
 * top-level shell commands (`cd web\nnpm test`).
 */
export function hasNewlineInsideQuotes(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let atLineStart = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "\n" || ch === "\r") return true;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\n" || ch === "\r") return true;
      if (ch === "\\") {
        let bs = 0;
        while (i + bs < command.length && command[i + bs] === "\\") bs++;
        if (command[i + bs] === '"') {
          i += bs;
          if (bs % 2 === 0) quote = null;
          continue;
        }
        i += bs - 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      atLineStart = true;
      continue;
    }
    if (atLineStart) {
      if (ch === " " || ch === "\t") continue;
      atLineStart = false;
      const rest = command.slice(i);
      if (rest.startsWith("::") || /^@?rem(?:\s|$)/i.test(rest)) {
        while (i < command.length && command[i] !== "\n" && command[i] !== "\r") {
          i++;
        }
        i--;
        continue;
      }
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "'") {
      // cmd.exe does not treat `'` as a quote delimiter; only open a single-quoted
      // span when preceded by start-of-string/whitespace/`=` (never mid-word
      // contractions like `don't`) AND closed by a matching `'` later in the command.
      const prev = i > 0 ? command[i - 1]! : "";
      if ((i === 0 || /[\s=]/.test(prev)) && command.indexOf("'", i + 1) !== -1) {
        quote = "'";
      }
    }
  }
  return false;
}

const WINDOWS_CMD_BUILTINS = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

const DIRECT_FORBIDDEN_UNQUOTED_RE = /[|&;><()`$%]/;

/**
 * Parses a single direct executable invocation whose arguments contain embedded
 * newlines inside quotes (e.g. `node -e "\nconst x = 42;\nconsole.log(\`val=${x}\`);\n"`)
 * using Windows CommandLineToArgvW backslash-before-quote rules, so it can be
 * spawned directly (`shell: false`) without cmd.exe truncation or PowerShell
 * double-quote interpolation. Returns `null` if any unquoted shell operator is present.
 */
export function parseDirectMultilineCommand(
  command: string,
): { bin: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens: string[] = [];
  let i = 0;

  while (i < trimmed.length) {
    while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) i++;
    if (i >= trimmed.length) break;
    if (trimmed[i] === "\r" || trimmed[i] === "\n") return null;

    let tok = "";
    let quote: '"' | "'" | null = null;
    while (i < trimmed.length) {
      const ch = trimmed[i]!;
      if (quote === null) {
        if (ch === " " || ch === "\t") break;
        if (ch === "\r" || ch === "\n") return null;
        if (DIRECT_FORBIDDEN_UNQUOTED_RE.test(ch)) return null;
        if (ch === '"' || ch === "'") {
          quote = ch;
          i++;
          continue;
        }
        tok += ch;
        i++;
        continue;
      }
      if (quote === "'") {
        if (ch === "'") {
          quote = null;
          i++;
          continue;
        }
        tok += ch;
        i++;
        continue;
      }
      // Double-quoted: follow Windows CommandLineToArgvW backslash-before-quote rules
      if (ch === "\\") {
        let bs = 0;
        while (i + bs < trimmed.length && trimmed[i + bs] === "\\") bs++;
        if (trimmed[i + bs] === '"') {
          tok += "\\".repeat(Math.floor(bs / 2));
          if (bs % 2 === 1) {
            tok += '"';
          } else {
            quote = null;
          }
          i += bs + 1;
          continue;
        }
        tok += "\\".repeat(bs);
        i += bs;
        continue;
      }
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      tok += ch;
      i++;
    }
    if (quote !== null) return null;
    tokens.push(tok);
  }

  if (tokens.length === 0) return null;
  const bin = tokens[0]!;
  if (!bin) return null;
  // Never spawn `.cmd`/`.bat` files with `shell: false` (Node >=18.20 / 20.12 / 22+ throws EINVAL).
  if (/\.(?:cmd|bat)$/i.test(bin)) return null;
  const base = path.win32.basename(bin).toLowerCase().replace(/\.exe$/, "");
  if (WINDOWS_CMD_BUILTINS.has(base) || WINDOWS_BATCH_SHIMS.has(base)) return null;
  return { bin, args: tokens.slice(1) };
}

const WINDOWS_BATCH_SHIMS = new Set([
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "corepack",
  "tsc",
  "tsx",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "biome",
  "next",
  "vite",
  "astro",
  "nuxt",
  "ng",
  "nx",
  "turbo",
  "playwright",
  "cypress",
]);

function escapeBatchStrayPercents(line: string): string {
  // Preserve already-doubled `%%` and valid `%ENV_VAR%` references; double stray
  // single `%` (including multi-`%` format strings like `"%H %s"` or `"%h - %s (%an)"`)
  // so cmd.exe batch files don't strip or expand them.
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") {
      out += line[i]!;
      continue;
    }
    if (line[i + 1] === "%") {
      out += "%%";
      i++;
      continue;
    }
    const envMatch = /^%(?:[A-Za-z_][A-Za-z0-9_]*|(?:Common)?ProgramFiles\(x86\))%/i.exec(
      line.slice(i),
    );
    if (envMatch) {
      out += envMatch[0]!;
      i += envMatch[0]!.length - 1;
      continue;
    }
    out += "%%";
  }
  return out;
}

function prefixCallForWindowsBatchShims(line: string): string {
  // Prefix `call ` on known `.cmd`/`.bat` shims (bare, path-qualified, or quoted)
  // at statement starts or after `&&` / `||` / `&` (outside quotes) so calling a
  // batch shim on line 1 returns control to line 2 in a temporary .cmd batch file.
  let out = "";
  let inQuotes = false;
  let atStmtStart = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (!inQuotes && atStmtStart) {
      if (ch === " " || ch === "\t") {
        out += ch;
        continue;
      }

      let cursor = i;
      let atPrefix = "";
      if (line[cursor] === "@") {
        atPrefix = "@";
        cursor++;
        while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
          atPrefix += line[cursor]!;
          cursor++;
        }
      }

      let rawTok = "";
      if (cursor < line.length && line[cursor] === '"') {
        const closeQuote = line.indexOf('"', cursor + 1);
        if (closeQuote !== -1) {
          const tailMatch = /^[^\s&|><()]*/.exec(line.slice(closeQuote + 1));
          const end = closeQuote + 1 + (tailMatch ? tailMatch[0]!.length : 0);
          rawTok = line.slice(cursor, end);
        }
      } else if (cursor < line.length) {
        const tokMatch = /^([^\s&|><()"]+)/.exec(line.slice(cursor));
        if (tokMatch) {
          rawTok = tokMatch[1]!;
        }
      }

      if (rawTok) {
        const unquoted = rawTok.replace(/"/g, "");
        const base = path.win32.basename(unquoted).toLowerCase();
        const baseNoExt = base.replace(/\.(?:cmd|bat)$/i, "");
        const isCallKeyword = unquoted.toLowerCase() === "call";
        if (
          !isCallKeyword &&
          (WINDOWS_BATCH_SHIMS.has(baseNoExt) || /\.(?:cmd|bat)$/i.test(base))
        ) {
          out += `${atPrefix}call ${rawTok}`;
        } else {
          out += `${atPrefix}${rawTok}`;
        }
        i = cursor + rawTok.length - 1;
        atStmtStart = false;
        continue;
      }

      if (atPrefix) {
        out += atPrefix;
        i = cursor - 1;
        atStmtStart = false;
        continue;
      }
      atStmtStart = false;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    if (!inQuotes && (ch === "&" || ch === "|")) {
      if (line[i + 1] === ch) {
        out += ch + ch;
        i++;
        atStmtStart = true;
        continue;
      }
      if (ch === "&") {
        out += ch;
        atStmtStart = true;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Builds a fail-fast Windows `.cmd` batch script for non-PowerShell multiline
 * commands (`cd packages/web\nnpm run build && npm test`, `set FOO=bar\necho %FOO%`,
 * `echo ok 2>nul\necho step2`) so they run natively in `cmd.exe` on ALL Windows
 * hosts (including Windows PowerShell 5.1 machines where `&&`/`||` fail in PS)
 * without silent line truncation or silent earlier-line failure masking.
 */
export function buildWindowsCmdBatchScript(command: string): string {
  const rawLines = command.trim().split(/\r?\n/);
  const out: string[] = ["@echo off"];
  let parenDepth = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("::") || /^@?rem(?:\s|$)/i.test(trimmed)) {
      out.push(rawLine);
      continue;
    }

    const processed = prefixCallForWindowsBatchShims(escapeBatchStrayPercents(rawLine));
    out.push(processed);

    // Track unquoted parenthesized blocks (`if (...)`) and `^` line continuations
    let inQuotes = false;
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      }
    }
    const continuesLine = /\^\s*$/.test(rawLine);
    const isLabel = /^:[A-Za-z0-9_.-]+$/.test(trimmed);
    if (parenDepth === 0 && !continuesLine && !isLabel) {
      out.push("if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%");
    }
  }

  return `${out.join("\r\n")}\r\n`;
}

let tempScriptSeq = 0;

async function runPowerShellScript(
  psExecutable: string,
  extraFlags: string[],
  fullScript: string,
  useEncoded: boolean,
  options: ExecOptions,
): Promise<ExecResult> {
  const baseFlags =
    extraFlags.length > 0
      ? extraFlags
      : ["-NoLogo", "-NoProfile", "-NonInteractive"];

  if (!useEncoded) {
    return spawnAndCollect(
      psExecutable,
      [...baseFlags, "-Command", fullScript],
      false,
      options,
    );
  }

  const encoded = encodePowerShellCommand(fullScript);
  if (encoded.length <= MAX_PS_ENCODED_COMMAND_CHARS) {
    return spawnAndCollect(
      psExecutable,
      [...baseFlags, "-EncodedCommand", encoded],
      false,
      options,
    );
  }

  // Fallback for oversized multiline scripts (> ~10.5 KB) that would exceed
  // Windows CreateProcess's 32,767-char command-line limit under UTF-16LE Base64.
  const tmpPs1 = path.join(
    os.tmpdir(),
    `agy-fast-ps-${process.pid}-${Date.now()}-${tempScriptSeq++}.ps1`,
  );
  try {
    // UTF-8 with BOM ensures Windows PowerShell 5.1 decodes Unicode scripts accurately
    await fs.writeFile(tmpPs1, `\uFEFF${fullScript}\r\n`, "utf8");
    const fileFlags = baseFlags.some((f) =>
      EXPLICIT_PS_VALUE_FLAGS.has(f.toLowerCase()),
    )
      ? baseFlags
      : [...baseFlags, "-ExecutionPolicy", "Bypass"];
    return await spawnAndCollect(
      psExecutable,
      [...fileFlags, "-File", tmpPs1],
      false,
      options,
    );
  } finally {
    await fs.rm(tmpPs1, { force: true }).catch(() => {});
  }
}

async function runWindowsMultilineCmdBatch(
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const tmpCmd = path.join(
    os.tmpdir(),
    `agy-fast-cmd-${process.pid}-${Date.now()}-${tempScriptSeq++}.cmd`,
  );
  const cmdExe = process.env.ComSpec || getWindowsSystem32Binary("cmd.exe").bin;
  try {
    await fs.writeFile(tmpCmd, buildWindowsCmdBatchScript(command), "utf8");
    return await spawnAndCollect(cmdExe, ["/d", "/c", tmpCmd], false, options);
  } finally {
    await fs.rm(tmpCmd, { force: true }).catch(() => {});
  }
}

let cachedWindowsPowerShell: WindowsPowerShellBin | null | undefined;
let cachedWindowsPowerShellExecPath: string | null = null;
let pendingWindowsPowerShellProbe: Promise<WindowsPowerShellBin | null> | null = null;

async function defaultProbeWindowsShell(bin: WindowsPowerShellBin): Promise<boolean> {
  const { bin: whereBin, cwd } = getWindowsSystem32Binary("where.exe");
  const exeQuery = bin.toLowerCase().endsWith(".exe") ? bin : `${bin}.exe`;
  const whereRes = await execBinaryAsync(whereBin, [exeQuery], {
    cwd,
    timeoutMs: 2000,
    maxOutputBytes: 4096,
  });
  if (!whereRes.error && !whereRes.timedOut) {
    if (whereRes.exitCode !== 0) return false;
    const resolved = whereRes.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\.exe$/i.test(line));
    if (!resolved) return false;
    cachedWindowsPowerShellExecPath = resolved;
    return true;
  }
  const res = await execBinaryAsync(
    exeQuery,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {
      cwd,
      timeoutMs: 3000,
      maxOutputBytes: 4096,
    },
  );
  if (!res.error && !res.timedOut && res.exitCode === 0) {
    cachedWindowsPowerShellExecPath = exeQuery;
    return true;
  }
  return false;
}

/**
 * Resolves the preferred PowerShell executable on Windows (`pwsh` -> `powershell.exe`
 * -> `null`), caching the probe result across calls.
 */
export async function resolveWindowsPowerShell(
  probe: WindowsShellProbe = defaultProbeWindowsShell,
): Promise<WindowsPowerShellBin | null> {
  if (cachedWindowsPowerShell !== undefined) {
    return cachedWindowsPowerShell;
  }
  if (pendingWindowsPowerShellProbe) {
    return pendingWindowsPowerShellProbe;
  }

  pendingWindowsPowerShellProbe = (async () => {
    try {
      cachedWindowsPowerShellExecPath = null;
      if (await probe("pwsh")) {
        cachedWindowsPowerShell = "pwsh";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      if (await probe("powershell.exe")) {
        cachedWindowsPowerShell = "powershell.exe";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      cachedWindowsPowerShell = null;
      return null;
    } finally {
      pendingWindowsPowerShellProbe = null;
    }
  })();

  return pendingWindowsPowerShellProbe;
}

export function resetWindowsShellCache(): void {
  cachedWindowsPowerShell = undefined;
  cachedWindowsPowerShellExecPath = null;
  pendingWindowsPowerShellProbe = null;
}

function hasDefinedEnvKey(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): boolean {
  if (env[key] !== undefined) return true;
  if (platform !== "win32") return false;
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper && env[existing] !== undefined) {
      return true;
    }
  }
  return false;
}

export function withNonInteractiveGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...baseEnv };
  if (!hasDefinedEnvKey(baseEnv, "GIT_TERMINAL_PROMPT", platform)) {
    result.GIT_TERMINAL_PROMPT = "0";
  }
  if (!hasDefinedEnvKey(baseEnv, "GCM_INTERACTIVE", platform)) {
    result.GCM_INTERACTIVE = "never";
  }
  return result;
}

export async function runShellCommandAsync(
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const effectiveOptions: ExecOptions = {
    ...options,
    env: withNonInteractiveGitEnv(options.env),
  };
  if (process.platform === "win32") {
    const effectiveCommand = unwrapTrivialWindowsPowerShellCommand(command).trim();
    const isMultiline = hasEmbeddedNewline(effectiveCommand);

    // 1. Explicit `pwsh`/`powershell` invocation with embedded newlines must NEVER
    // fall through to cmd.exe (which truncates at the first line break).
    if (isMultiline && EXPLICIT_POWERSHELL_INVOCATION_RE.test(effectiveCommand)) {
      const parsedExplicit = parseExplicitMultilinePowerShell(effectiveCommand);
      if (parsedExplicit) {
        const scriptBody = buildPowerShellUtf8Command(parsedExplicit.script);
        return runPowerShellScript(
          parsedExplicit.bin,
          parsedExplicit.flags,
          scriptBody,
          true,
          effectiveOptions,
        );
      }
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        error:
          "Multiline explicit PowerShell invocation with outer shell chaining is not supported on Windows; pass the PowerShell script directly without wrapping it in `pwsh -Command`.",
      };
    }

    // 2. PowerShell-syntax commands (single-line or multiline)
    if (needsPowerShellOnWindows(effectiveCommand)) {
      const psBin = await resolveWindowsPowerShell();
      if (psBin) {
        const utf8Command = buildPowerShellUtf8Command(effectiveCommand);
        return runPowerShellScript(
          cachedWindowsPowerShellExecPath ?? psBin,
          [],
          utf8Command,
          isMultiline,
          effectiveOptions,
        );
      }
      if (isMultiline) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          error:
            "Multiline PowerShell command requires pwsh or powershell.exe on Windows, which was not found.",
        };
      }
    }

    // 3. Non-PowerShell multiline commands: never pass raw newlines to `cmd.exe /c`
    if (isMultiline) {
      if (hasNewlineInsideQuotes(effectiveCommand)) {
        const direct = parseDirectMultilineCommand(effectiveCommand);
        if (direct) {
          return spawnAndCollect(direct.bin, direct.args, false, effectiveOptions);
        }
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          truncated: false,
          error:
            "Multiline quoted arguments combined with shell operators are not supported by cmd.exe on Windows; use a script file or PowerShell syntax.",
        };
      }
      return runWindowsMultilineCmdBatch(effectiveCommand, effectiveOptions);
    }

    return spawnAndCollect(effectiveCommand, [], true, effectiveOptions);
  }
  return spawnAndCollect(command, [], true, effectiveOptions);
}

function spawnAndCollect(
  commandOrBin: string,
  args: string[],
  shell: boolean,
  options: ExecOptions,
): Promise<ExecResult> {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";

  return new Promise<ExecResult>((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let settleFallbackTimer: NodeJS.Timeout | null = null;
    let sigkillTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      sigkillTimer = killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: decodeProcessOutput(Buffer.concat(stdoutChunks), stdoutTruncated),
        stderr: decodeProcessOutput(Buffer.concat(stderrChunks), stderrTruncated),
        truncated: stdoutTruncated || stderrTruncated,
        error,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (err) => {
      finish(null, null, err.message);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

let cachedRgAvailable: boolean | null = null;
let pendingRgProbe: Promise<boolean> | null = null;

export async function isRipgrepAvailable(): Promise<boolean> {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  if (pendingRgProbe) return pendingRgProbe;

  let probe: Promise<boolean> | null = null;
  probe = (async () => {
    try {
      const res = await execBinaryAsync("rg", ["--version"], {
        cwd: os.tmpdir(),
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      });
      const available = !res.error && !res.timedOut && res.exitCode === 0;
      if (!res.timedOut && pendingRgProbe === probe) {
        cachedRgAvailable = available;
      }
      return available;
    } finally {
      if (pendingRgProbe === probe) {
        pendingRgProbe = null;
      }
    }
  })();

  pendingRgProbe = probe;
  return probe;
}

export function resetRipgrepCache(): void {
  cachedRgAvailable = null;
  pendingRgProbe = null;
}
