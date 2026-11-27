import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  TOOL_VALIDATION_EXAMPLES,
  withValidationExample,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { MCP_CALL_BUDGET_SEC, runShellCommandAsync } from "../utils/exec-utils.js";
import {
  detectUtf16Bom,
  hasUtf8Bom,
  isLikelyBinary,
  readTextFile,
  resolvePath,
  toPosixPath,
} from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  fitSectionsToByteBudget,
  formatExitFailureLabel,
  prepareCompactCommandOutput,
  renderPreparedCompactCommandOutput,
  sliceSafeChars,
  truncateHeadTailWithByteNotice,
  truncateWithByteNotice,
} from "../utils/output-filter.js";

export interface EditHunk {
  target: string;
  replacement: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
}

export interface FileEdit {
  path: string;
  hunks?: EditHunk[];
  create?: string;
  overwrite?: boolean;
}

export interface VerifySpec {
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface ApplyEditsInput {
  cwd?: string;
  /** A JSON array string of file edits, or the array itself. */
  edits: string | FileEdit[];
  dryRun?: boolean;
  bestEffort?: boolean;
  diff?: boolean;
  verify?: string | VerifySpec;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

interface MatchSpan {
  start: number;
  end: number;
  replacement: string;
  hunkIndex: number;
}

interface PlannedWrite {
  absPath: string;
  writeTargetPath: string;
  relPath: string;
  existed: boolean;
  originalBuffer: Buffer | null;
  originalMode: number | null;
  originalSymlinkTarget?: string | null;
  newContent: string;
  hunkCount: number;
  lineDelta: number;
  created: boolean;
  isNoOp: boolean;
  diffText?: string;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function formatMatchLineRange(
  lineStarts: number[],
  offset: number,
  length: number,
  prefix = "L",
): string {
  const startLine = offsetToLine(lineStarts, offset);
  const endOffset = length > 0 ? offset + length - 1 : offset;
  const endLine = offsetToLine(lineStarts, endOffset);
  return startLine === endLine
    ? `${prefix}${startLine}`
    : `${prefix}${startLine}-${prefix}${endLine}`;
}

function getLineWindowOffsets(
  text: string,
  lineStarts: number[],
  startLine?: number,
  endLine?: number,
): { windowStart: number; windowEnd: number } {
  if (
    startLine !== undefined &&
    (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)
  ) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (
    endLine !== undefined &&
    (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)
  ) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }

  const totalLines = lineStarts.length;
  const sLine = startLine !== undefined ? Math.trunc(startLine) : 1;
  const requestedEnd = endLine !== undefined ? Math.trunc(endLine) : undefined;

  if (requestedEnd !== undefined && requestedEnd < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${requestedEnd}). Correct the line bounds for this path.`);
  }
  if (startLine !== undefined && sLine > totalLines) {
    const unit = totalLines === 1 ? "line" : "lines";
    throw new Error(`startLine ${sLine} exceeds file length (${totalLines} ${unit}). Check 'path' and refresh the line bounds.`);
  }

  const eLine = Math.min(totalLines, requestedEnd ?? totalLines);
  const windowStart = lineStarts[sLine - 1] ?? text.length;
  const windowEnd =
    eLine < totalLines ? lineStarts[eLine]! : text.length;
  return { windowStart, windowEnd };
}

const MAX_NEARBY_LINES = 26;

function formatNearbyLines(
  text: string,
  startLine?: number,
  endLine?: number,
): string {
  if (startLine === undefined && endLine === undefined) return "";
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  if (from > rawTo) return "";
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  const extra = truncated ? `\n    ... (${rawTo - to} more lines in range omitted)` : "";
  return `\n  Nearby lines (${from}-${to}):\n${snippet.join("\n")}${extra}`;
}

function extractLineTokens(trimmedLine: string): string[] {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * Locate the closest matching region in the file (optionally bounded to a
 * 1-based line window) so the caller can fix a mismatched hunk immediately
 * without dumping an 80-line range or doing an extra read_file round-trip.
 */
function findClosestRegionSnippet(
  normalizedContent: string,
  normTarget: string,
  rangeStartLine?: number,
  rangeEndLine?: number,
): string {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";

  const targetLines = normTarget
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";

  interface HunkAnchor {
    text: string;
    idx: number;
    tokens: Set<string>;
  }

  let firstAnchorIdx = 0;
  for (let idx = 0; idx < targetLines.length; idx++) {
    if (targetLines[idx]!.length >= 6) {
      firstAnchorIdx = idx;
      break;
    }
  }
  let longestAnchorIdx = 0;
  for (let idx = 1; idx < targetLines.length; idx++) {
    if (targetLines[idx]!.length > targetLines[longestAnchorIdx]!.length) {
      longestAnchorIdx = idx;
    }
  }
  const lastAnchorIdx = targetLines.length - 1;

  const anchorIndices = new Set<number>([firstAnchorIdx, longestAnchorIdx]);
  if (targetLines[lastAnchorIdx]!.length >= 8) {
    anchorIndices.add(lastAnchorIdx);
  }
  const anchors: HunkAnchor[] = [...anchorIndices].map((idx) => ({
    text: targetLines[idx]!,
    idx,
    tokens: new Set(extractLineTokens(targetLines[idx]!)),
  }));
  const targetTokenSets = targetLines.map((tl) => new Set(extractLineTokens(tl)));

  const trimmedFileLines = fileLines.map((l) => l.trim());

  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1,
  );
  if (scanStart > scanEnd) return "";

  const evaluatedStarts = new Set<number>();
  let bestStart = -1;
  let bestScore = 0;

  const scoreIndices: number[] = [];
  const windowLen = Math.min(targetLines.length, 10);
  for (let k = 0; k < windowLen; k++) {
    scoreIndices.push(k);
  }
  for (const idx of anchorIndices) {
    if (idx >= windowLen) {
      scoreIndices.push(idx);
    }
  }

  const scoreCandidateStart = (candStart: number): number => {
    let total = 0;
    for (const k of scoreIndices) {
      const fIdx = candStart + k;
      if (fIdx > scanEnd || fIdx >= trimmedFileLines.length) continue;
      const fLine = trimmedFileLines[fIdx]!;
      const tLine = targetLines[k]!;
      if (!fLine || !tLine) continue;
      const tTokens = targetTokenSets[k]!;
      const isHighEntropy = tLine.length >= 12 && tTokens.size >= 2;
      if (fLine === tLine) {
        total += isHighEntropy
          ? 8 + Math.min(6, tLine.length / 14)
          : 4;
      } else if (
        tLine.length >= 8 &&
        (fLine.includes(tLine) || tLine.includes(fLine))
      ) {
        total += isHighEntropy ? 6 : 3.5;
      } else if (tTokens.size > 0) {
        const lineTokens = extractLineTokens(fLine);
        let hits = 0;
        for (const tok of lineTokens) {
          if (tTokens.has(tok)) hits += 1;
        }
        if (
          hits >= 2 ||
          (hits >= 1 && tTokens.size <= 2 && hits === tTokens.size)
        ) {
          total += (isHighEntropy ? 4.5 : 3) * (hits / tTokens.size);
        }
      }
    }
    return total;
  };

  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i]!;
    if (!line) continue;

    for (const anchor of anchors) {
      let matchedAnchor = false;
      if (
        line === anchor.text ||
        (anchor.text.length >= 8 &&
          (line.includes(anchor.text) || anchor.text.includes(line)))
      ) {
        matchedAnchor = true;
      } else if (anchor.tokens.size > 0) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (anchor.tokens.has(tok)) hits += 1;
        }
        if (
          hits >= 2 ||
          (hits >= 1 && anchor.tokens.size <= 2 && hits === anchor.tokens.size)
        ) {
          matchedAnchor = true;
        }
      }
      if (!matchedAnchor) continue;

      const candStart = Math.max(scanStart, Math.min(scanEnd, i - anchor.idx));
      if (evaluatedStarts.has(candStart)) continue;
      evaluatedStarts.add(candStart);

      const score = scoreCandidateStart(candStart);
      if (score > bestScore) {
        bestScore = score;
        bestStart = candStart;
      }
    }
  }

  if (bestStart < 0 || bestScore < 2.5) return "";

  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestStart + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestStart + 1 + span + 2));
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  return `\n  Closest match near line ${bestStart + 1} (lines ${from}-${to}):\n${snippet.join("\n")}`;
}

function planHunksForContent(
  normalizedContent: string,
  hunks: EditHunk[],
  displayPath: string,
): { newNormalized: string; appliedMatches: number; spans: MatchSpan[]; errors: string[] } {
  const lineStarts = computeLineStarts(normalizedContent);
  // Drop the EOF marker from the editable line range.
  if (lineStarts.at(-1) === normalizedContent.length) lineStarts.pop();
  const spans: MatchSpan[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (!isPlainObject(hunk)) {
      errors.push(`${displayPath} hunk #${idx + 1}: must be an object with 'target' and 'replacement'`);
      continue;
    }
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }

    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");

    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine,
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const foundOffsets: number[] = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }

    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== undefined || hunk.endLine !== undefined;
      const rangeNote = hasRange
        ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}`
        : "";
      let hint = " Re-read the file and copy the exact current target, including whitespace, or correct 'path'.";
      if (hasRange) {
        // Check if exact target exists outside the provided line window (line drift)
        const globalOffsets: number[] = [];
        let gPos = 0;
        while (
          gPos <= normalizedContent.length - normTarget.length &&
          globalOffsets.length < 5
        ) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets
            .map((o) => formatMatchLineRange(lineStarts, o, normTarget.length))
            .join(", ");
          let action = "choose bounds covering the intended matches.";
          if (globalOffsets.length === 1 && !hunk.replaceAll) {
            const start = globalOffsets[0]!;
            const firstLine = offsetToLine(lineStarts, start);
            const lastLine = offsetToLine(lineStarts, start + normTarget.length - 1);
            action = `use startLine: ${firstLine}, endLine: ${lastLine} or omit both bounds.`;
          } else if (!hunk.replaceAll) {
            action = "narrow the bounds to one match or include more surrounding text.";
          }
          hint = ` Exact match found outside range at ${hitLines} — check 'path', then ${action}`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint +=
              findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) ||
              findClosestRegionSnippet(normalizedContent, normTarget) ||
              formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint += formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint += findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`,
      );
      continue;
    }

    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets
        .slice(0, 10)
        .map((o) => formatMatchLineRange(lineStarts, o, normTarget.length, ""))
        .join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Narrow the line bounds or include more surrounding text. Set replaceAll: true only if every match in scope should change.`,
      );
      continue;
    }

    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx,
      });
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors };
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const curr = spans[i]!;
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}. Combine them into one hunk using the current file text as the target.`,
      );
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors };
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));

  return {
    newNormalized: pieces.join(""),
    appliedMatches: spans.length,
    spans,
    errors: [],
  };
}

function buildNormToRawOffsetMap(rawContent: string, normLength: number): Int32Array {
  const map = new Int32Array(normLength + 1);
  let normIdx = 0;
  for (let rawIdx = 0; rawIdx < rawContent.length; rawIdx++) {
    if (rawContent[rawIdx] === "\r" && rawContent[rawIdx + 1] === "\n") {
      map[normIdx++] = rawIdx;
      rawIdx++;
    } else {
      map[normIdx++] = rawIdx;
    }
  }
  map[normIdx] = rawContent.length;
  return map;
}

function detectLocalSpanEol(
  rawContent: string,
  rawStart: number,
  rawEnd: number,
  fallbackEol: "\r\n" | "\n",
): "\r\n" | "\n" {
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let i = rawStart; i < rawEnd; i++) {
    if (rawContent[i] === "\n") {
      if (i > rawStart && rawContent[i - 1] === "\r") crlfCount++;
      else lfOnlyCount++;
    }
  }
  if (crlfCount > lfOnlyCount) return "\r\n";
  if (lfOnlyCount > crlfCount) return "\n";

  // Span had no decisive newline; match the terminating EOL of the line being edited
  for (let i = rawEnd; i < rawContent.length; i++) {
    if (rawContent[i] === "\n") {
      return i > 0 && rawContent[i - 1] === "\r" ? "\r\n" : "\n";
    }
  }

  // Final line without trailing newline (or tie): fall back to preceding line's EOL
  for (let i = rawStart - 1; i >= 0; i--) {
    if (rawContent[i] === "\n") {
      return i > 0 && rawContent[i - 1] === "\r" ? "\r\n" : "\n";
    }
  }

  return fallbackEol;
}

function applySpansPreservingMixedEol(
  rawContent: string,
  normLength: number,
  spans: MatchSpan[],
  fallbackEol: "\r\n" | "\n",
): string {
  const normToRaw = buildNormToRawOffsetMap(rawContent, normLength);
  const pieces: string[] = [];
  let rawCursor = 0;
  for (const span of spans) {
    const rawStart = normToRaw[span.start]!;
    const rawEnd = normToRaw[span.end]!;
    pieces.push(rawContent.slice(rawCursor, rawStart));
    const localEol = detectLocalSpanEol(rawContent, rawStart, rawEnd, fallbackEol);
    pieces.push(
      localEol === "\r\n"
        ? span.replacement.replace(/\n/g, "\r\n")
        : span.replacement,
    );
    rawCursor = rawEnd;
  }
  pieces.push(rawContent.slice(rawCursor));
  return pieces.join("");
}

function countLines(text: string): number {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

const OVERWRITE_HEADER_PEEK_BYTES = 8192;

async function readFileHeaderBytes(
  filePath: string,
  maxBytes = OVERWRITE_HEADER_PEEK_BYTES,
): Promise<Buffer> {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function classifyNonTextOverwriteBuffer(
  buf: Buffer,
  relPath: string,
): string | null {
  const utf16Bom = detectUtf16Bom(buf);
  if (utf16Bom) {
    return `${relPath}: UTF-16 encoded file is not supported (convert to UTF-8 first) [${utf16Bom}]`;
  }
  if (isLikelyBinary(buf)) {
    return `${relPath}: Cannot overwrite binary file with text content`;
  }
  return null;
}

async function readOverwriteOriginal(
  writeTargetPath: string,
  size: number,
  relPath: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  if (size > OVERWRITE_HEADER_PEEK_BYTES) {
    const header = await readFileHeaderBytes(writeTargetPath, OVERWRITE_HEADER_PEEK_BYTES);
    const nonTextErr = classifyNonTextOverwriteBuffer(header, relPath);
    if (nonTextErr) {
      return { ok: false, error: nonTextErr };
    }
  }
  const buffer = await fs.readFile(writeTargetPath);
  const nonTextErr = classifyNonTextOverwriteBuffer(buffer, relPath);
  if (nonTextErr) {
    return { ok: false, error: nonTextErr };
  }
  return { ok: true, buffer };
}

/**
 * Returns true if any path segment targets Git internal metadata (`.git`).
 * Matches case-insensitively across all platforms (including WSL/case-insensitive mounts)
 * and strips Win32 NTFS ADS suffixes (`:stream`) and trailing dots/spaces on Windows,
 * while never blocking `.gitignore`, `.github`, `.gitattributes`, `.gitmodules`,
 * `.gitkeep`, or names like `repo.git`.
 */
export function isGitInternalPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const segments = filePath.split(/[\\/]+/);
  for (const rawSeg of segments) {
    if (!rawSeg) continue;
    let seg = rawSeg.toLowerCase();
    if (platform === "win32") {
      seg = seg
        .replace(/[. ]+$/, "")
        .replace(/:.*$/, "")
        .replace(/[. ]+$/, "");
    }
    if (seg === ".git") {
      return true;
    }
  }
  return false;
}

async function canonicalizeTargetPath(absPath: string): Promise<string> {
  try {
    return await fs.realpath(absPath);
  } catch {
    // Walk up to the nearest existing ancestor so symlinks such as
    // `sym_dir/new_sub/file.ts` or `sym_git/new_sub/hook` deduplicate and
    // trigger path-safety checks cleanly.
    const trailingSegments: string[] = [];
    let current = absPath;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return absPath;
      }
      trailingSegments.push(path.basename(current));
      current = parent;
      try {
        const realAncestor = await fs.realpath(current);
        return path.join(realAncestor, ...trailingSegments.reverse());
      } catch {
        // Continue walking up to an existing ancestor
      }
    }
  }
}

async function findMissingAncestorDirs(dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  while (true) {
    try {
      await fs.lstat(current);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        break;
      }
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return missing;
}

async function commitPlannedWrites(plans: PlannedWrite[]): Promise<void> {
  const written: PlannedWrite[] = [];
  const createdDirs: string[] = [];
  const createdDirSet = new Set<string>();

  try {
    for (const plan of plans) {
      if (plan.isNoOp) continue;
      const target = plan.writeTargetPath;
      const dir = path.dirname(target);
      const missingDirs = await findMissingAncestorDirs(dir);
      for (let i = missingDirs.length - 1; i >= 0; i--) {
        const d = missingDirs[i]!;
        if (!createdDirSet.has(d)) {
          createdDirSet.add(d);
          createdDirs.push(d);
        }
      }
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = path.join(
        dir,
        `.agy-tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        await fs.writeFile(tmpPath, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          await fs.chmod(tmpPath, plan.originalMode);
        }
      } catch (tmpErr) {
        try {
          await fs.unlink(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        throw tmpErr;
      }

      try {
        await fs.rename(tmpPath, target);
        written.push(plan);
      } catch (renameErr) {
        // Fallback if rename across filesystems or directory permissions fails
        try {
          await fs.unlink(tmpPath);
        } catch {
          // ignore cleanup failure
        }
        written.push(plan);
        if (plan.originalSymlinkTarget) {
          // Replace dangling symlink itself instead of following it on fallback write
          try {
            await fs.unlink(target);
          } catch {
            // ignore unlink failure
          }
        }
        await fs.writeFile(target, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          try {
            await fs.chmod(target, plan.originalMode);
          } catch {
            // ignore chmod failure on unsupported filesystems
          }
        }
        void renameErr;
      }
    }
  } catch (err) {
    // Rollback all previously written files
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i]!;
      const target = item.writeTargetPath;
      try {
        if (item.originalSymlinkTarget) {
          await fs.unlink(target).catch(() => {});
          await fs.symlink(item.originalSymlinkTarget, target);
        } else if (item.existed && item.originalBuffer !== null) {
          await fs.writeFile(target, item.originalBuffer);
          if (item.originalMode !== null && process.platform !== "win32") {
            await fs.chmod(target, item.originalMode);
          }
        } else if (!item.existed) {
          await fs.unlink(target);
        }
      } catch {
        // Best-effort rollback
      }
    }
    // Best-effort remove newly created parent directories deepest-first (rmdir never removes non-empty dirs)
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try {
        await fs.rmdir(createdDirs[i]!);
      } catch {
        // Ignore ENOENT / ENOTEMPTY / permission errors
      }
    }
    throw err;
  }
}

function corruptedEditsError(items: CorruptedItem[]): { text: string; isError: boolean } {
  return {
    text: formatCorruptedArrayError({
      header: "Validation failed (0 files modified)",
      toolName: "apply_edits",
      items,
      fallbackAdvice:
        "fall back to built-in edit_file / write_file for this batch only. Use apply_edits again for the next batch.",
    }),
    isError: true,
  };
}

function resolveHunkFieldWithAliases(
  rawHunk: Record<string, unknown>,
  canonicalKey: "target" | "replacement",
  aliasKeys: readonly string[],
): { ok: true; value: unknown } | { ok: false; error: string } {
  const hasCanonical = rawHunk[canonicalKey] !== undefined;
  const presentAliases = aliasKeys.filter((key) => rawHunk[key] !== undefined);

  if (hasCanonical) {
    const canonicalVal = rawHunk[canonicalKey];
    for (const aliasKey of presentAliases) {
      if (rawHunk[aliasKey] !== canonicalVal) {
        return {
          ok: false,
          error: `conflicting '${canonicalKey}' and alias '${aliasKey}' (values differ; omit the alias or make them identical)`,
        };
      }
    }
    return { ok: true, value: canonicalVal };
  }

  if (presentAliases.length === 0) {
    return { ok: true, value: undefined };
  }

  const firstKey = presentAliases[0]!;
  const firstVal = rawHunk[firstKey];
  for (let k = 1; k < presentAliases.length; k++) {
    const otherKey = presentAliases[k]!;
    if (rawHunk[otherKey] !== firstVal) {
      return {
        ok: false,
        error: `conflicting aliases '${firstKey}' and '${otherKey}' (values differ; use '${canonicalKey}')`,
      };
    }
  }
  return { ok: true, value: firstVal };
}

function normalizeEditHunk(
  rawHunk: Record<string, unknown>,
): { ok: true; hunk: EditHunk } | { ok: false; errors: string[] } {
  const targetRes = resolveHunkFieldWithAliases(rawHunk, "target", [
    "oldText",
    "old_string",
  ]);
  const replacementRes = resolveHunkFieldWithAliases(rawHunk, "replacement", [
    "newText",
    "new_string",
  ]);
  const errors: string[] = [];
  if (!targetRes.ok) errors.push(targetRes.error);
  if (!replacementRes.ok) errors.push(replacementRes.error);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    hunk: {
      ...(rawHunk as unknown as EditHunk),
      target: (targetRes as { ok: true; value: unknown }).value as string,
      replacement: (replacementRes as { ok: true; value: unknown }).value as string,
    },
  };
}

function formatErrorBulletsWithinBytes(
  heading: string,
  errors: string[],
  maxBytes: number,
): string {
  const full = `${heading}\n- ${errors.join("\n- ")}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }
  const headingPrefix = `${heading}\n`;
  const availBytes = maxBytes - Buffer.byteLength(headingPrefix, "utf8");
  if (availBytes <= 64 || errors.length <= 1) {
    return truncateWithByteNotice(full, maxBytes);
  }
  const fittedBullets = fitSectionsToByteBudget(
    errors.map((e) => `- ${e}`),
    availBytes,
    availBytes,
    "\n",
  );
  const assembled = `${headingPrefix}${fittedBullets}`;
  return Buffer.byteLength(assembled, "utf8") <= maxBytes
    ? assembled
    : truncateWithByteNotice(assembled, maxBytes);
}

function formatAppliedCountPhrase(
  totalCount: number,
  noOpCount: number,
  dryRun: boolean,
): string {
  if (dryRun) {
    return noOpCount > 0 ? `${totalCount} valid (${noOpCount} unchanged)` : `${totalCount} valid`;
  }
  const writtenCount = totalCount - noOpCount;
  return noOpCount > 0 ? `${writtenCount} written, ${noOpCount} unchanged` : `${writtenCount} written`;
}

function formatAppliedSummaryCompact(
  totalCount: number,
  noOpCount: number,
  dryRun: boolean,
): string {
  if (dryRun) {
    return noOpCount > 0
      ? `${totalCount} file(s) valid (${noOpCount} unchanged)`
      : `${totalCount} file(s) valid`;
  }
  const writtenCount = totalCount - noOpCount;
  return noOpCount > 0
    ? `${writtenCount} file(s) written, ${noOpCount} unchanged`
    : `${writtenCount} file(s) written`;
}

function compactSummaryLinesToBytes(
  header: string,
  summaryLines: string[],
  noOpCount: number,
  maxBytes: number,
): string {
  const full = `${header}\n${summaryLines.join("\n")}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }
  const countSummary = formatAppliedSummaryCompact(summaryLines.length, noOpCount, false);
  const totalPhrase = formatAppliedCountPhrase(summaryLines.length, noOpCount, false);
  const minimal = `${header} (${countSummary}; list omitted to preserve verify diagnostics)`;
  const headerPrefix = `${header}\n`;
  const kept: string[] = [];
  let usedBytes = Buffer.byteLength(headerPrefix, "utf8");

  for (let i = 0; i < summaryLines.length; i++) {
    const line = summaryLines[i]!;
    const remaining = summaryLines.length - (i + 1);
    const omitNotice =
      remaining > 0
        ? `\n... (+${remaining} more applied file(s) omitted; total ${totalPhrase})`
        : "";
    const lineBytes = (kept.length > 0 ? 1 : 0) + Buffer.byteLength(line, "utf8");
    if (usedBytes + lineBytes + Buffer.byteLength(omitNotice, "utf8") > maxBytes) {
      break;
    }
    kept.push(line);
    usedBytes += lineBytes;
  }

  if (kept.length > 0) {
    const omitted = summaryLines.length - kept.length;
    return omitted > 0
      ? `${headerPrefix}${kept.join("\n")}\n... (+${omitted} more applied file(s) omitted; total ${totalPhrase})`
      : `${headerPrefix}${kept.join("\n")}`;
  }
  return Buffer.byteLength(minimal, "utf8") <= maxBytes
    ? minimal
    : truncateWithByteNotice(minimal, maxBytes);
}
function formatBestEffortPartialResult(params: {
  partialHeader: string;
  errors: string[];
  summaryLines: string[];
  noOpCount: number;
  dryRun: boolean;
  verifySkipped: boolean;
  maxBytes: number;
}): string {
  const { partialHeader, errors, summaryLines, noOpCount, dryRun, verifySkipped, maxBytes } = params;
  const failedHeading = dryRun
    ? "Failed (correct these files and retry the full dry run):"
    : "Failed (retry all intended edits for these failed files; skip applied files):";
  const failedFull = `${failedHeading}\n- ${errors.join("\n- ")}`;
  const appliedFull = `Applied:\n${summaryLines.join("\n")}`;
  const verifyNote = verifySkipped
    ? "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify."
    : "";

  const joinSections = (failedText: string, appliedText: string): string => {
    const parts = [partialHeader, failedText, appliedText];
    if (verifyNote) parts.push(verifyNote);
    return parts.join("\n\n");
  };

  const fullText = joinSections(failedFull, appliedFull);
  if (Buffer.byteLength(fullText, "utf8") <= maxBytes) {
    return fullText;
  }

  const countSummary = formatAppliedSummaryCompact(summaryLines.length, noOpCount, dryRun);
  const totalPhrase = formatAppliedCountPhrase(summaryLines.length, noOpCount, dryRun);
  const minimalApplied = `Applied: ${countSummary} (list omitted to preserve failure diagnostics).`;

  const fixedBytes =
    Buffer.byteLength(partialHeader, "utf8") +
    4 + // "\n\n" before failed + "\n\n" before applied
    (verifyNote ? 2 + Buffer.byteLength(verifyNote, "utf8") : 0);

  // Protect failure diagnostics first while reserving minimal space for the Applied summary
  const minAppliedBytes = Math.min(
    Buffer.byteLength(appliedFull, "utf8"),
    Buffer.byteLength(minimalApplied, "utf8"),
  );
  const maxFailedBytes = Math.max(256, maxBytes - fixedBytes - minAppliedBytes);
  const failedSection = formatErrorBulletsWithinBytes(
    failedHeading,
    errors,
    maxFailedBytes,
  );

  const remainingForApplied =
    maxBytes - fixedBytes - Buffer.byteLength(failedSection, "utf8");

  let appliedSection = minimalApplied;
  if (remainingForApplied >= Buffer.byteLength(appliedFull, "utf8")) {
    appliedSection = appliedFull;
  } else {
    const appliedPrefix = "Applied:\n";
    const keptLines: string[] = [];
    let usedBytes = Buffer.byteLength(appliedPrefix, "utf8");

    for (let i = 0; i < summaryLines.length; i++) {
      const line = summaryLines[i]!;
      const remainingCount = summaryLines.length - (i + 1);
      const omitNotice =
        remainingCount > 0
          ? `\n... (+${remainingCount} more applied file(s) omitted; total ${totalPhrase})`
          : "";
      const lineBytes = (keptLines.length > 0 ? 1 : 0) + Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + Buffer.byteLength(omitNotice, "utf8") > remainingForApplied) {
        break;
      }
      keptLines.push(line);
      usedBytes += lineBytes;
    }

    if (keptLines.length > 0) {
      const omitted = summaryLines.length - keptLines.length;
      appliedSection =
        omitted > 0
          ? `${appliedPrefix}${keptLines.join("\n")}\n... (+${omitted} more applied file(s) omitted; total ${totalPhrase})`
          : `${appliedPrefix}${keptLines.join("\n")}`;
    }
  }

  const assembled = joinSections(failedSection, appliedSection);
  return Buffer.byteLength(assembled, "utf8") <= maxBytes
    ? assembled
    : truncateWithByteNotice(assembled, maxBytes);
}

const DIFF_CONTEXT_LINES = 2;
const CREATED_DIFF_MAX_LINES = 40;
const DIFF_LCS_CELL_LIMIT = 40_000;

interface DiffOp {
  kind: " " | "-" | "+";
  line: string;
  oldIdx: number;
  newIdx: number;
}

function splitDiffLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  if (text.endsWith("\n")) {
    return { lines: text.slice(0, -1).split("\n"), hasTrailingNewline: true };
  }
  return { lines: text.split("\n"), hasTrailingNewline: false };
}

function computeLineDiffOps(
  oldLines: string[],
  newLines: string[],
  oldBase = 0,
  newBase = 0,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    ops.push({
      kind: " ",
      line: oldLines[prefix]!,
      oldIdx: oldBase + prefix,
      newIdx: newBase + prefix,
    });
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aEnd = oldLines.length - suffix;
  const bEnd = newLines.length - suffix;
  const aLen = aEnd - prefix;
  const bLen = bEnd - prefix;

  if (aLen > 0 || bLen > 0) {
    if (aLen === 0) {
      for (let j = prefix; j < bEnd; j++) {
        ops.push({ kind: "+", line: newLines[j]!, oldIdx: oldBase + prefix, newIdx: newBase + j });
      }
    } else if (bLen === 0) {
      for (let i = prefix; i < aEnd; i++) {
        ops.push({ kind: "-", line: oldLines[i]!, oldIdx: oldBase + i, newIdx: newBase + prefix });
      }
    } else if (aLen * bLen <= DIFF_LCS_CELL_LIMIT) {
      const cols = bLen + 1;
      const dp = new Int32Array((aLen + 1) * cols);
      for (let i = aLen - 1; i >= 0; i--) {
        const row = i * cols;
        const nextRow = (i + 1) * cols;
        for (let j = bLen - 1; j >= 0; j--) {
          if (oldLines[prefix + i] === newLines[prefix + j]) {
            dp[row + j] = dp[nextRow + j + 1]! + 1;
          } else {
            const down = dp[nextRow + j]!;
            const right = dp[row + j + 1]!;
            dp[row + j] = down >= right ? down : right;
          }
        }
      }
      let i = 0;
      let j = 0;
      while (i < aLen && j < bLen) {
        if (oldLines[prefix + i] === newLines[prefix + j]) {
          ops.push({
            kind: " ",
            line: oldLines[prefix + i]!,
            oldIdx: oldBase + prefix + i,
            newIdx: newBase + prefix + j,
          });
          i++;
          j++;
        } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
          ops.push({
            kind: "-",
            line: oldLines[prefix + i]!,
            oldIdx: oldBase + prefix + i,
            newIdx: newBase + prefix + j,
          });
          i++;
        } else {
          ops.push({
            kind: "+",
            line: newLines[prefix + j]!,
            oldIdx: oldBase + prefix + i,
            newIdx: newBase + prefix + j,
          });
          j++;
        }
      }
      while (i < aLen) {
        ops.push({
          kind: "-",
          line: oldLines[prefix + i]!,
          oldIdx: oldBase + prefix + i,
          newIdx: newBase + prefix + j,
        });
        i++;
      }
      while (j < bLen) {
        ops.push({
          kind: "+",
          line: newLines[prefix + j]!,
          oldIdx: oldBase + prefix + i,
          newIdx: newBase + prefix + j,
        });
        j++;
      }
    } else {
      for (let i = prefix; i < aEnd; i++) {
        ops.push({ kind: "-", line: oldLines[i]!, oldIdx: oldBase + i, newIdx: newBase + prefix });
      }
      for (let j = prefix; j < bEnd; j++) {
        ops.push({ kind: "+", line: newLines[j]!, oldIdx: oldBase + aEnd, newIdx: newBase + j });
      }
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oldI = aEnd + s;
    const newI = bEnd + s;
    ops.push({
      kind: " ",
      line: oldLines[oldI]!,
      oldIdx: oldBase + oldI,
      newIdx: newBase + newI,
    });
  }
  return ops;
}

function formatUnifiedHunksFromOps(
  ops: DiffOp[],
  contextLines = DIFF_CONTEXT_LINES,
): string[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== " ") {
      changeIndices.push(i);
    }
  }
  if (changeIndices.length === 0) return [];

  const clusters: Array<{ start: number; end: number }> = [];
  let clusterStart = changeIndices[0]!;
  let clusterEnd = changeIndices[0]!;
  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - clusterEnd <= contextLines * 2 + 1) {
      clusterEnd = idx;
    } else {
      clusters.push({ start: clusterStart, end: clusterEnd });
      clusterStart = idx;
      clusterEnd = idx;
    }
  }
  clusters.push({ start: clusterStart, end: clusterEnd });

  return clusters.map(({ start, end }) => {
    const winStart = Math.max(0, start - contextLines);
    const winEnd = Math.min(ops.length - 1, end + contextLines);
    const hunkOps = ops.slice(winStart, winEnd + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const op of hunkOps) {
      if (op.kind !== "+") oldCount++;
      if (op.kind !== "-") newCount++;
    }
    const firstOp = hunkOps[0]!;
    const oldStart = oldCount === 0 ? firstOp.oldIdx : firstOp.oldIdx + 1;
    const newStart = newCount === 0 ? firstOp.newIdx : firstOp.newIdx + 1;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    const body = hunkOps.map((op) => `${op.kind}${op.line}`);
    return `${header}\n${body.join("\n")}`;
  });
}

function buildCompactDiffForHunkPlans(
  relPath: string,
  normalizedOriginal: string,
  spans: MatchSpan[],
): string {
  if (spans.length === 0) return "";
  const lineStarts = computeLineStarts(normalizedOriginal);
  const { lines: oldLines, hasTrailingNewline: oldTrailingNl } =
    splitDiffLines(normalizedOriginal);
  const maxLineIdx = Math.max(0, oldLines.length - 1);

  interface SpanLineGroup {
    startLineIdx: number;
    endLineIdx: number;
    spans: MatchSpan[];
  }

  const rawGroups: SpanLineGroup[] = [];
  for (const span of spans) {
    const rawStartLine = offsetToLine(lineStarts, span.start) - 1;
    const startLineIdx = Math.min(maxLineIdx, rawStartLine);
    let endLineIdx =
      span.end > span.start
        ? Math.min(maxLineIdx, offsetToLine(lineStarts, span.end - 1) - 1)
        : startLineIdx;
    // If a replacement drops the trailing newline of a non-final line (including empty
    // replacement after a non-empty prefix), the following line merges onto it — pull it in.
    if (
      endLineIdx < oldLines.length - 1 &&
      span.end > span.start &&
      normalizedOriginal[span.end - 1] === "\n" &&
      (span.replacement.length > 0 || span.start > (lineStarts[startLineIdx] ?? 0)) &&
      !span.replacement.endsWith("\n")
    ) {
      endLineIdx++;
    }

    const prev = rawGroups[rawGroups.length - 1];
    if (prev && startLineIdx <= prev.endLineIdx + DIFF_CONTEXT_LINES * 2 + 1) {
      prev.endLineIdx = Math.max(prev.endLineIdx, endLineIdx);
      prev.spans.push(span);
    } else {
      rawGroups.push({ startLineIdx, endLineIdx, spans: [span] });
    }
  }

  const computeRegionNewText = (group: SpanLineGroup): string => {
    const byteStart = lineStarts[group.startLineIdx] ?? 0;
    const byteEnd =
      group.endLineIdx + 1 < lineStarts.length && group.endLineIdx + 1 < oldLines.length
        ? lineStarts[group.endLineIdx + 1]!
        : normalizedOriginal.length;
    const pieces: string[] = [];
    let cursor = byteStart;
    for (const sp of group.spans) {
      pieces.push(normalizedOriginal.slice(cursor, sp.start));
      pieces.push(sp.replacement);
      cursor = sp.end;
    }
    pieces.push(normalizedOriginal.slice(cursor, byteEnd));
    return pieces.join("");
  };

  // Enforce region-boundary newline-drop closure for multi-span cascades:
  // e.g. span 1 drops trailing '\n' (pulling L+1) while span 2 deletes L+1 completely,
  // so L+2 also merges onto span 1 and must be pulled into the group (absorbing any
  // overlapping context window).
  const groups: SpanLineGroup[] = [];
  let gi = 0;
  while (gi < rawGroups.length) {
    const current: SpanLineGroup = {
      startLineIdx: rawGroups[gi]!.startLineIdx,
      endLineIdx: rawGroups[gi]!.endLineIdx,
      spans: [...rawGroups[gi]!.spans],
    };
    gi++;

    while (true) {
      while (
        gi < rawGroups.length &&
        rawGroups[gi]!.startLineIdx <= current.endLineIdx + DIFF_CONTEXT_LINES * 2 + 1
      ) {
        const nxt = rawGroups[gi]!;
        current.endLineIdx = Math.max(current.endLineIdx, nxt.endLineIdx);
        current.spans.push(...nxt.spans);
        gi++;
      }

      if (current.endLineIdx >= oldLines.length - 1) {
        break;
      }
      const regionNewText = computeRegionNewText(current);
      if (regionNewText.length === 0 || regionNewText.endsWith("\n")) {
        break;
      }
      current.endLineIdx++;
    }
    groups.push(current);
  }

  const allHunks: string[] = [];
  let cumulativeDelta = 0;

  for (const group of groups) {
    const regionStart = group.startLineIdx;
    const regionEnd = group.endLineIdx;
    const regionNewText = computeRegionNewText(group);

    const regionOldLines = oldLines.slice(regionStart, regionEnd + 1);
    const regionNewLines = splitDiffLines(regionNewText).lines;

    const ctxBeforeStart = Math.max(0, regionStart - DIFF_CONTEXT_LINES);
    const ctxAfterEnd = Math.min(oldLines.length - 1, regionEnd + DIFF_CONTEXT_LINES);
    const newRegionStart = regionStart + cumulativeDelta;

    const ops: DiffOp[] = [];
    for (let i = ctxBeforeStart; i < regionStart; i++) {
      ops.push({
        kind: " ",
        line: oldLines[i]!,
        oldIdx: i,
        newIdx: i + cumulativeDelta,
      });
    }
    ops.push(
      ...computeLineDiffOps(regionOldLines, regionNewLines, regionStart, newRegionStart),
    );
    const afterNewDelta = cumulativeDelta + (regionNewLines.length - regionOldLines.length);
    for (let i = regionEnd + 1; i <= ctxAfterEnd; i++) {
      ops.push({
        kind: " ",
        line: oldLines[i]!,
        oldIdx: i,
        newIdx: i + afterNewDelta,
      });
    }

    allHunks.push(...formatUnifiedHunksFromOps(ops, DIFF_CONTEXT_LINES));
    cumulativeDelta = afterNewDelta;
  }

  if (allHunks.length === 0) {
    const lastOld = oldLines.length;
    const lastNew = lastOld + cumulativeDelta;
    const note = oldTrailingNl ? "trailing newline removed" : "trailing newline added";
    allHunks.push(`@@ -${lastOld},0 +${lastNew},0 @@\n\\ ${note}`);
  }

  return `--- a/${relPath}\n+++ b/${relPath}\n${allHunks.join("\n")}`;
}

function buildCompactDiffForCreate(
  relPath: string,
  originalBuffer: Buffer | null,
  createBodyNormalized: string,
  existed: boolean,
): string {
  const { lines: newLines, hasTrailingNewline: newTrailingNl } =
    splitDiffLines(createBodyNormalized);
  if (!existed || !originalBuffer) {
    if (newLines.length === 0) {
      return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +0,0 @@\n (empty file)`;
    }
    const shown = newLines.slice(0, CREATED_DIFF_MAX_LINES);
    const omitted = newLines.length - shown.length;
    const body = shown.map((l) => `+${l}`).join("\n");
    const suffix = omitted > 0 ? `\n... (+${omitted} more created line(s))` : "";
    return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${newLines.length} @@\n${body}${suffix}`;
  }

  const rawOld = (
    hasUtf8Bom(originalBuffer) ? originalBuffer.subarray(3) : originalBuffer
  ).toString("utf8");
  const { lines: oldLines, hasTrailingNewline: oldTrailingNl } = splitDiffLines(
    rawOld.replace(/\r\n/g, "\n"),
  );
  const ops = computeLineDiffOps(oldLines, newLines, 0, 0);
  const hunks = formatUnifiedHunksFromOps(ops, DIFF_CONTEXT_LINES);
  if (hunks.length === 0) {
    if (oldTrailingNl === newTrailingNl) return "";
    const note = oldTrailingNl ? "trailing newline removed" : "trailing newline added";
    hunks.push(`@@ -${oldLines.length},0 +${newLines.length},0 @@\n\\ ${note}`);
  }
  return `--- a/${relPath}\n+++ b/${relPath}\n${hunks.join("\n")}`;
}

function packCompactDiffsWithinBudget(diffBlocks: string[], maxBytes: number): string {
  if (diffBlocks.length === 0 || maxBytes < 140) return "";
  const joined = diffBlocks.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= maxBytes) {
    return joined;
  }

  const footer =
    "\n... [diff truncated to fit 8800B budget; line stats above remain complete]";
  const contentBudget = maxBytes - Buffer.byteLength(footer, "utf8");
  if (contentBudget < 80) return "";

  const kept: string[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const block of diffBlocks) {
    const sepBeforeBlock = kept.length > 0 ? 1 : 0;
    const blockBytes = sepBeforeBlock + Buffer.byteLength(block, "utf8");
    if (usedBytes + blockBytes <= contentBudget) {
      kept.push(...block.split("\n"));
      usedBytes += blockBytes;
      continue;
    }

    // Try partial prefix of this block only if at least one hunk body line fits.
    // Identify file headers positionally (indices 0..1) so deleted `--...` or added
    // `++...` source lines are never misclassified as `---`/`+++` file headers.
    const blockLines = block.split("\n");
    const candidateLines: string[] = [];
    let candidateBytes = usedBytes;
    let lastBodyEnd = 0;

    for (let lineIdx = 0; lineIdx < blockLines.length; lineIdx++) {
      const line = blockLines[lineIdx]!;
      const sep = kept.length > 0 || candidateLines.length > 0 ? 1 : 0;
      const lineBytes = sep + Buffer.byteLength(line, "utf8");
      if (candidateBytes + lineBytes > contentBudget) {
        break;
      }
      candidateLines.push(line);
      candidateBytes += lineBytes;
      if (lineIdx >= 2 && !line.startsWith("@@ ")) {
        lastBodyEnd = candidateLines.length;
      }
    }

    truncated = true;
    if (lastBodyEnd > 0) {
      const validSlice = candidateLines.slice(0, lastBodyEnd);
      const validText = validSlice.join("\n");
      usedBytes += (kept.length > 0 ? 1 : 0) + Buffer.byteLength(validText, "utf8");
      kept.push(...validSlice);
      break;
    }
  }

  if (kept.length === 0) {
    return truncated
      ? "... [diff omitted to fit 8800B budget; line stats above remain complete]"
      : "";
  }
  return truncated ? `${kept.join("\n")}${footer}` : kept.join("\n");
}

export async function runApplyEdits(
  input: ApplyEditsInput,
): Promise<{ text: string; isError: boolean }> {
  const parsedEdits = parseMaybeJsonArray(input?.edits);
  if (!parsedEdits.ok) {
    if (
      parsedEdits.kind === "corrupted_literal" ||
      (parsedEdits.kind === "wrong_type" &&
        (typeof input?.edits === "boolean" || input?.edits === null))
    ) {
      return corruptedEditsError([
        {
          label: "edits",
          value: parsedEdits.kind === "corrupted_literal" ? parsedEdits.value : input.edits,
          expected: "an array of edit objects",
        },
      ]);
    }
    if (parsedEdits.kind === "invalid_json") {
      return {
        text: withValidationExample(
          `Error: 'edits' is not a valid JSON array (0 files modified): ${parsedEdits.detail}`,
          TOOL_VALIDATION_EXAMPLES.apply_edits,
        ),
        isError: true,
      };
    }
    return {
      text: withValidationExample(
        "Error: 'edits' must be a non-empty JSON array string (or array) of file edit objects.",
        TOOL_VALIDATION_EXAMPLES.apply_edits,
      ),
      isError: true,
    };
  }
  const rawEdits = parsedEdits.value;
  // A model never means to send zero edits; on agy CLI 1.5.x a long native
  // array of edit objects can reach the server as [] with the payload lost.
  if (rawEdits.length === 0) {
    return corruptedEditsError([
      { label: "edits", value: rawEdits, expected: "a non-empty array of edit objects" },
    ]);
  }
  if (rawEdits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true,
    };
  }

  // Detect nested-JSON serialization corruption (e.g. edits: [true], [false, true], [null], or hunks: [true])
  // before regular validation so the caller immediately falls back instead of retrying in a loop.
  const corruptedItems: CorruptedItem[] = [];
  const normalizedEdits: Array<FileEdit & { hunkAliasErrors?: Array<{ hunkIndex: number; message: string }> }> = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i];
    if (!isPlainObject(rawEntry)) {
      corruptedItems.push({ label: `edits[${i}]`, value: rawEntry, expected: "an edit object" });
      continue;
    }
    let normalizedHunks: EditHunk[] | undefined;
    const hunkAliasErrors: Array<{ hunkIndex: number; message: string }> = [];
    if (rawEntry.hunks !== undefined) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks);
      if (!parsedHunks.ok) {
        corruptedItems.push({
          label: `edits[${i}].hunks`,
          value: parsedHunks.kind === "corrupted_literal" ? parsedHunks.value : rawEntry.hunks,
          expected: "an array of hunk objects",
        });
        continue;
      }
      let hunkCorrupted = false;
      const resolvedHunks: EditHunk[] = [];
      for (let j = 0; j < parsedHunks.value.length; j++) {
        const rawHunk = parsedHunks.value[j];
        if (!isPlainObject(rawHunk)) {
          corruptedItems.push({
            label: `edits[${i}].hunks[${j}]`,
            value: rawHunk,
            expected: "a hunk object",
          });
          hunkCorrupted = true;
          continue;
        }
        const normRes = normalizeEditHunk(rawHunk);
        if (!normRes.ok) {
          for (const message of normRes.errors) {
            hunkAliasErrors.push({ hunkIndex: j, message });
          }
        } else {
          resolvedHunks.push(normRes.hunk);
        }
      }
      if (hunkCorrupted) continue;
      normalizedHunks = resolvedHunks;
    }
    normalizedEdits.push({
      path: rawEntry.path as string,
      hunks: normalizedHunks,
      create: rawEntry.create as string | undefined,
      overwrite: rawEntry.overwrite as boolean | undefined,
      ...(hunkAliasErrors.length > 0 ? { hunkAliasErrors } : {}),
    });
  }
  if (corruptedItems.length > 0) {
    return corruptedEditsError(corruptedItems);
  }

  // Validate optional verify spec up front before touching any files on disk
  let validatedVerify: VerifySpec | null = null;
  if (input.verify !== undefined) {
    if (typeof input.verify === "string") {
      if (input.verify.trim()) {
        validatedVerify = { command: input.verify };
      }
    } else if (isPlainObject(input.verify)) {
      const cmd = input.verify.command;
      if (typeof cmd !== "string" || !cmd.trim()) {
        return {
          text: withValidationExample(
            "Validation failed (0 files modified):\n- 'verify.command' must be a non-empty string.",
            TOOL_VALIDATION_EXAMPLES.apply_edits,
          ),
          isError: true,
        };
      }
      if (input.verify.cwd !== undefined && typeof input.verify.cwd !== "string") {
        return {
          text: withValidationExample(
            "Validation failed (0 files modified):\n- 'verify.cwd' must be a string.",
            TOOL_VALIDATION_EXAMPLES.apply_edits,
          ),
          isError: true,
        };
      }
      const rawSpecTimeout = input.verify.timeoutSec as unknown;
      const parsedSpecTimeout =
        (typeof rawSpecTimeout === "number" ||
          (typeof rawSpecTimeout === "string" && rawSpecTimeout.trim() !== ""))
          ? Number(rawSpecTimeout)
          : undefined;
      validatedVerify = {
        command: cmd,
        cwd: input.verify.cwd,
        timeoutSec:
          parsedSpecTimeout !== undefined && Number.isFinite(parsedSpecTimeout)
            ? parsedSpecTimeout
            : undefined,
      };
    } else {
      return {
        text: withValidationExample(
          "Validation failed (0 files modified):\n- 'verify' must be a command string or { command, cwd?, timeoutSec? } object.",
          TOOL_VALIDATION_EXAMPLES.apply_edits,
        ),
        isError: true,
      };
    }
  }

  if (input.diff !== undefined && typeof input.diff !== "boolean") {
    return {
      text: withValidationExample(
        "Validation failed (0 files modified):\n- 'diff' must be a boolean.",
        TOOL_VALIDATION_EXAMPLES.apply_edits,
      ),
      isError: true,
    };
  }
  const includeDiff = input.diff === true;

  const baseCwd = resolvePath(input.cwd || process.cwd());

  if (!input.dryRun && validatedVerify?.cwd) {
    const resolvedVerifyCwd = resolvePath(validatedVerify.cwd, baseCwd);
    try {
      const st = await fs.stat(resolvedVerifyCwd);
      if (!st.isDirectory()) {
        return {
          text: `Validation failed (0 files modified):\n- 'verify.cwd' is not a directory: ${validatedVerify.cwd}`,
          isError: true,
        };
      }
    } catch {
      return {
        text: `Validation failed (0 files modified):\n- 'verify.cwd' directory not found: ${validatedVerify.cwd}`,
        isError: true,
      };
    }
  }

  // Merge entries targeting the same resolved file (including symlink aliases and symlinked parent dirs)
  const mergedByPath = new Map<
    string,
    {
      absPath: string;
      writeTargetPath: string;
      relPath: string;
      create?: string;
      overwrite?: boolean;
      hunks: EditHunk[];
    }
  >();
  const errors: string[] = [];

  for (let i = 0; i < normalizedEdits.length; i++) {
    const entry = normalizedEdits[i]!;
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      if (entry.hunkAliasErrors) {
        for (const err of entry.hunkAliasErrors) {
          errors.push(`edits[${i}] hunk #${err.hunkIndex + 1}: ${err.message}`);
        }
      }
      continue;
    }

    const absPath = resolvePath(entry.path, baseCwd);
    const writeTargetPath = await canonicalizeTargetPath(absPath);
    const relPath = toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);
    if (entry.hunkAliasErrors && entry.hunkAliasErrors.length > 0) {
      for (const err of entry.hunkAliasErrors) {
        errors.push(`${relPath} hunk #${err.hunkIndex + 1}: ${err.message}`);
      }
      continue;
    }
    if (isGitInternalPath(absPath) || isGitInternalPath(writeTargetPath)) {
      errors.push(`${relPath}: refusing to modify Git internal metadata path (.git)`);
      continue;
    }
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;

    if (!hasCreate && !hasHunks) {
      errors.push(`${relPath}: must specify either non-empty 'hunks' or 'create'`);
      continue;
    }
    if (hasCreate && hasHunks) {
      errors.push(`${relPath}: cannot specify both 'create' and 'hunks' on the same entry`);
      continue;
    }

    const existing = mergedByPath.get(writeTargetPath);
    if (!existing) {
      mergedByPath.set(writeTargetPath, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : undefined,
        overwrite: entry.overwrite,
        hunks: hasHunks ? [...entry.hunks!] : [],
      });
    } else {
      if (hasCreate || existing.create !== undefined) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' with other edits`);
        continue;
      }
      existing.hunks.push(...entry.hunks!);
    }
  }

  if (errors.length > 0) {
    const exampleSuffix = `\nExample: ${TOOL_VALIDATION_EXAMPLES.apply_edits}`;
    const exampleSuffixBytes = Buffer.byteLength(exampleSuffix, "utf8");
    const formatted = formatErrorBulletsWithinBytes(
      "Validation failed (0 files modified):",
      errors,
      DEFAULT_INLINE_MAX_BYTES - exampleSuffixBytes,
    );
    return {
      text: withValidationExample(formatted, TOOL_VALIDATION_EXAMPLES.apply_edits),
      isError: true,
    };
  }

  // Phase 1: validate and plan every file in memory
  const plans: PlannedWrite[] = [];
  for (const item of mergedByPath.values()) {
    if (item.create !== undefined) {
      let exists = false;
      let originalBuffer: Buffer | null = null;
      let originalMode: number | null = null;
      let originalSymlinkTarget: string | null = null;
      try {
        const lst = await fs.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs.stat(item.writeTargetPath);
            if (st.isDirectory()) {
              errors.push(`${item.relPath}: target path is a directory`);
              continue;
            }
            exists = true;
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: file already exists (set overwrite: true to replace it)`,
              );
              continue;
            }
            originalMode = st.mode & 0o7777;
            const origRes = await readOverwriteOriginal(
              item.writeTargetPath,
              st.size,
              item.relPath,
            );
            if (!origRes.ok) {
              errors.push(origRes.error);
              continue;
            }
            originalBuffer = origRes.buffer;
          } catch (statErr) {
            if ((statErr as NodeJS.ErrnoException)?.code === "ENOENT") {
              // Dangling symlink: never clobber without overwrite: true, and preserve target for rollback
              exists = true;
              if (!item.overwrite) {
                errors.push(
                  `${item.relPath}: dangling symlink already exists (set overwrite: true to replace it)`,
                );
                continue;
              }
              originalSymlinkTarget = await fs.readlink(item.writeTargetPath);
            } else {
              errors.push(
                `${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
              );
              continue;
            }
          }
        } else {
          const st = await fs.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: target path is a directory`);
            continue;
          }
          exists = true;
          if (!item.overwrite) {
            errors.push(
              `${item.relPath}: file already exists (set overwrite: true to replace it)`,
            );
            continue;
          }
          originalMode = st.mode & 0o7777;
          const origRes = await readOverwriteOriginal(
            item.writeTargetPath,
            st.size,
            item.relPath,
          );
          if (!origRes.ok) {
            errors.push(origRes.error);
            continue;
          }
          originalBuffer = origRes.buffer;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          exists = false;
          originalBuffer = null;
          originalMode = null;
        } else {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      const originalHadBom = originalBuffer ? hasUtf8Bom(originalBuffer) : false;
      const oldLines = originalBuffer
        ? countLines((originalHadBom ? originalBuffer.subarray(3) : originalBuffer).toString("utf8"))
        : 0;
      const newContent =
        originalHadBom && !item.create.startsWith("\uFEFF")
          ? `\uFEFF${item.create}`
          : item.create;
      const createBody = item.create.startsWith("\uFEFF") ? item.create.slice(1) : item.create;
      const newLines = countLines(createBody);
      const diffText = includeDiff
        ? buildCompactDiffForCreate(
            item.relPath,
            originalBuffer,
            createBody.replace(/\r\n/g, "\n"),
            exists,
          )
        : undefined;
      plans.push({
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
        newContent,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists,
        isNoOp: false,
        diffText,
      });
      continue;
    }

    // Existing file hunks
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!isUtf8(fileData.rawBuffer)) {
      errors.push(
        `${item.relPath}: file is not valid UTF-8 (hunk edits would corrupt non-UTF-8 bytes; convert to UTF-8 first or rewrite the whole file with create + overwrite: true)`,
      );
      continue;
    }

    const normalizedOriginal = fileData.rawContent.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }

    const normalizedUnchanged = planned.newNormalized === normalizedOriginal;
    let newContent = "";
    let isNoOp = normalizedUnchanged;
    if (!normalizedUnchanged) {
      const finalContent = fileData.mixedEol
        ? applySpansPreservingMixedEol(
            fileData.rawContent,
            normalizedOriginal.length,
            planned.spans,
            fileData.eol,
          )
        : fileData.eol === "\r\n"
          ? planned.newNormalized.replace(/\n/g, "\r\n")
          : planned.newNormalized;
      newContent =
        fileData.hasBom && !finalContent.startsWith("\uFEFF")
          ? `\uFEFF${finalContent}`
          : finalContent;
      isNoOp =
        Buffer.byteLength(newContent, "utf8") === fileData.rawBuffer.length &&
        Buffer.from(newContent, "utf8").equals(fileData.rawBuffer);
    }

    const lineDelta = normalizedUnchanged
      ? 0
      : countLines(planned.newNormalized) - countLines(normalizedOriginal);
    const diffText =
      includeDiff && !isNoOp
        ? buildCompactDiffForHunkPlans(
            item.relPath,
            normalizedOriginal,
            planned.spans,
          )
        : undefined;

    plans.push({
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
      isNoOp,
      diffText,
    });
  }

  const bestEffort = Boolean(input.bestEffort);

  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const heading = bestEffort
      ? "Edit aborted (0 files modified):"
      : "Atomic edit aborted (0 files modified):";
    const prefix = `${heading}\nRetry the full corrected batch.`;
    const hasSchemaTypeError = errors.some(
      (e) =>
        e.includes("'target' must be") ||
        e.includes("'replacement' must be") ||
        e.includes("must be an object with 'target' and 'replacement'"),
    );
    if (hasSchemaTypeError) {
      const exampleSuffix = `\nExample: ${TOOL_VALIDATION_EXAMPLES.apply_edits}`;
      const exampleSuffixBytes = Buffer.byteLength(exampleSuffix, "utf8");
      const formatted = formatErrorBulletsWithinBytes(
        prefix,
        errors,
        DEFAULT_INLINE_MAX_BYTES - exampleSuffixBytes,
      );
      return {
        text: withValidationExample(formatted, TOOL_VALIDATION_EXAMPLES.apply_edits),
        isError: true,
      };
    }
    return {
      text: formatErrorBulletsWithinBytes(prefix, errors, DEFAULT_INLINE_MAX_BYTES),
      isError: true,
    };
  }

  // Phase 2: write valid planned files (unless dryRun)
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  const summaryLines = plans.map((p) => {
    if (p.isNoOp) {
      return `- ${p.relPath}: unchanged (no-op: replacement identical to target)`;
    }
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created
      ? "created"
      : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });
  const noOpCount = plans.filter((p) => p.isNoOp).length;
  const writtenCount = plans.length - noOpCount;

  if (bestEffort && errors.length > 0) {
    const totalFiles = mergedByPath.size;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const unchangedSuffix = noOpCount > 0 ? `, ${noOpCount} unchanged` : "";
    const partialHeader = input.dryRun
      ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):`
      : `Partial edit applied (${writtenCount}/${totalFiles} file(s) written${unchangedSuffix}; ${failedFileCount} file(s) failed — do NOT re-send applied files):`;
    return {
      text: formatBestEffortPartialResult({
        partialHeader,
        errors,
        summaryLines,
        noOpCount,
        dryRun: Boolean(input.dryRun),
        verifySkipped: Boolean(!input.dryRun && input.verify),
        maxBytes: DEFAULT_INLINE_MAX_BYTES,
      }),
      isError: true,
    };
  }

  const header = input.dryRun
    ? `Dry run validated ${plans.length} file(s) (0 files modified):`
    : noOpCount > 0
      ? `Applied edits to ${writtenCount} file(s) (${noOpCount} unchanged):`
      : `Applied edits to ${plans.length} file(s):`;
  const appliedFull = `${header}\n${summaryLines.join("\n")}`;

  // Phase 3: optional inline verify
  if (!input.dryRun && validatedVerify) {
    const verifySpec = validatedVerify;
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const timeoutCandidate: unknown = verifySpec.timeoutSec ?? input.verifyTimeoutSec;
    const rawTimeoutSec =
      (typeof timeoutCandidate === "number" ||
        (typeof timeoutCandidate === "string" && timeoutCandidate.trim() !== ""))
        ? Number(timeoutCandidate)
        : 60;
    const timeoutMs =
      (Number.isFinite(rawTimeoutSec)
        ? Math.max(1, Math.min(MCP_CALL_BUDGET_SEC, Math.trunc(rawTimeoutSec)))
        : 60) * 1000;
    const rawMaxVerifyChars = Number(input.maxVerifyChars ?? 4000);
    const maxVerifyChars = Number.isFinite(rawMaxVerifyChars)
      ? Math.max(300, Math.min(7_500, Math.trunc(rawMaxVerifyChars)))
      : 4000;

    const res = await runShellCommandAsync(verifySpec.command, {
      cwd: verifyCwd,
      timeoutMs,
    });

    const status = res.timedOut
      ? "TIMEOUT"
      : res.error
        ? "ERROR"
        : res.exitCode === 0
          ? "PASS"
          : `FAIL (${formatExitFailureLabel(res.exitCode, res.signal)})`;
    const verifyPrefix = `\n\nVerify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:\n`;
    const preparedVerify = prepareCompactCommandOutput({
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      error: res.error,
    });

    const minApplied = `${header} (${formatAppliedSummaryCompact(summaryLines.length, noOpCount, false)}; list omitted to preserve verify diagnostics)`;
    const reservedForApplied =
      status === "PASS"
        ? Math.min(
            Buffer.byteLength(appliedFull, "utf8"),
            DEFAULT_INLINE_MAX_BYTES - 512,
          )
        : Math.min(
            Buffer.byteLength(appliedFull, "utf8"),
            Buffer.byteLength(minApplied, "utf8"),
          );
    const maxVerifyBodyBytes = Math.max(
      256,
      DEFAULT_INLINE_MAX_BYTES -
        reservedForApplied -
        Buffer.byteLength(verifyPrefix, "utf8"),
    );

    let targetChars = Math.min(maxVerifyChars, maxVerifyBodyBytes);
    let formatted = renderPreparedCompactCommandOutput(
      preparedVerify,
      targetChars,
    ).text;
    for (let iter = 0; iter < 4; iter++) {
      const actualBytes = Buffer.byteLength(formatted, "utf8");
      if (actualBytes <= maxVerifyBodyBytes || targetChars <= 64) break;
      targetChars = Math.max(
        64,
        Math.floor(targetChars * (maxVerifyBodyBytes / actualBytes) * 0.94),
      );
      formatted = renderPreparedCompactCommandOutput(
        preparedVerify,
        targetChars,
      ).text;
    }
    if (Buffer.byteLength(formatted, "utf8") > maxVerifyBodyBytes) {
      formatted = truncateHeadTailWithByteNotice(formatted, maxVerifyBodyBytes);
    }

    const verifySection = `${verifyPrefix}${formatted}`;
    const remainingAppliedBytes =
      DEFAULT_INLINE_MAX_BYTES - Buffer.byteLength(verifySection, "utf8");
    const appliedSection = compactSummaryLinesToBytes(
      header,
      summaryLines,
      noOpCount,
      Math.max(64, remainingAppliedBytes),
    );
    const combined = `${appliedSection}${verifySection}`;
    let finalText =
      Buffer.byteLength(combined, "utf8") <= DEFAULT_INLINE_MAX_BYTES
        ? combined
        : truncateWithByteNotice(combined, DEFAULT_INLINE_MAX_BYTES);

    // Priority: preserve verify diagnostics & applied summary first; only emit compact diff
    // in leftover budget when verify passed and the full applied summary fit without omission.
    if (includeDiff && status === "PASS" && appliedSection === appliedFull) {
      const diffBlocks = plans
        .map((p) => p.diffText)
        .filter((d): d is string => Boolean(d));
      if (diffBlocks.length > 0) {
        const remaining =
          DEFAULT_INLINE_MAX_BYTES - Buffer.byteLength(finalText, "utf8") - 2;
        const packedDiff = packCompactDiffsWithinBudget(diffBlocks, remaining);
        if (packedDiff) {
          finalText = `${finalText}\n\n${packedDiff}`;
        }
      }
    }

    return {
      text: finalText,
      isError: false,
    };
  }

  if (includeDiff) {
    const diffBlocks = plans
      .map((p) => p.diffText)
      .filter((d): d is string => Boolean(d));
    const appliedBytes = Buffer.byteLength(appliedFull, "utf8");
    if (diffBlocks.length > 0 && appliedBytes <= DEFAULT_INLINE_MAX_BYTES) {
      const remaining = DEFAULT_INLINE_MAX_BYTES - appliedBytes - 2;
      const packedDiff = packCompactDiffsWithinBudget(diffBlocks, remaining);
      if (packedDiff) {
        return {
          text: `${appliedFull}\n\n${packedDiff}`,
          isError: false,
        };
      }
    }
  }

  return {
    text: truncateWithByteNotice(appliedFull, DEFAULT_INLINE_MAX_BYTES),
    isError: false,
  };
}
