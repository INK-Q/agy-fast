import path from "node:path";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { readTextFile, resolvePath, toPosixPath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  computeWaterFillBudgets,
  fitSectionsToByteBudget,
  sliceSafeChars,
} from "../utils/output-filter.js";

export interface SliceRequest {
  path: string;
  ranges: Array<[number, number]>;
}

export interface ReadSlicesInput {
  cwd?: string;
  outlines?: string[];
  slices?: Array<SliceRequest | string>;
  lineRanges?: string[];
  maxChars?: number;
}

export interface QuickOutlineInput {
  cwd?: string;
  paths?: string[];
  maxChars?: number;
}

export interface SymbolEntry {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  depth: number;
}

type BraceLang = "js" | "c" | "go" | "rust" | "shell" | "json";

interface ScanState {
  inBlockComment: boolean;
  templateExprStack: number[]; // tracks open `{` depth inside `${...}` of nested template strings
  inBacktick: boolean;
  parenDepth?: number;
  rustRawHashes?: number;
}

function isRegexStartContext(line: string, slashIdx: number): boolean {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j]!)) j--;
  if (j < 0) return true;
  const prev = line[j]!;
  if (prev === "!") {
    // TypeScript postfix non-null assertion (`arr[0]! / 2`, `fn()! / n`, `x! / y`) is a value, not unary `!`
    let b = j - 1;
    while (b >= 0 && /\s/.test(line[b]!)) b--;
    if (b >= 0 && /[\w$)\]'`"]/.test(line[b]!)) return false;
    return true;
  }
  if ((prev === "+" || prev === "-") && j > 0 && line[j - 1] === prev) {
    // Postfix `i++ / 2` or `i-- / 2` ends an expression
    let b = j - 2;
    while (b >= 0 && /\s/.test(line[b]!)) b--;
    if (b >= 0 && /[\w$)\]]/.test(line[b]!)) return false;
  }
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  // Check preceding keyword (return, case, throw, in, of, typeof, void, delete, new)
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k]!)) k--;
  const word = line.slice(k + 1, j + 1);
  return (
    word === "return" ||
    word === "case" ||
    word === "throw" ||
    word === "in" ||
    word === "of" ||
    word === "typeof" ||
    word === "void" ||
    word === "delete" ||
    word === "new"
  );
}

function hasClosingRegexSlashOnLine(line: string, openSlashIdx: number): boolean {
  let escaped = false;
  let inClass = false;
  for (let i = openSlashIdx + 1; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      continue;
    }
    if (ch === "/" && !inClass) {
      return true;
    }
  }
  return false;
}

function isJsxSelfClosingSlash(line: string, slashIdx: number): boolean {
  if (line[slashIdx + 1] !== ">") return false;
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j]!)) j--;
  // JSX self-closing `/>` only reaches regex-start context after `}` (e.g. `<Icon s={1} />`)
  // or on a continuation line (`  />`); regex literals like `/>/g` or `/>}/` follow `(`, `=`, `return`, etc.
  if (j >= 0 && line[j] !== "}") return false;
  return line[slashIdx + 2] !== "/";
}

function scanBracesOnLine(
  line: string,
  state: ScanState,
  lang: BraceLang,
  ignoreBracesInParensBeforeOpen = false,
  alreadySeenOpen = false,
): {
  open: number;
  close: number;
  openParen: number;
  closeParen: number;
  endsWithSemi: boolean;
  lastCodeChar: string;
} {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth ?? 0;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (lang === "rust" && (state.rustRawHashes ?? -1) >= 0) {
      if (ch === '"') {
        const needed = state.rustRawHashes!;
        let matchedHashes = true;
        for (let h = 0; h < needed; h++) {
          if (line[i + 1 + h] !== "#") {
            matchedHashes = false;
            break;
          }
        }
        if (matchedHashes) {
          state.rustRawHashes = -1;
          i += needed;
          lastCodeChar = '"';
        }
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }

    if (state.inBacktick) {
      if (ch === "\\" && lang !== "go") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }

    // Comments
    if (
      lang === "shell" &&
      ch === "#" &&
      (i === 0 || /[\s;&|()]/.test(line[i - 1]!))
    ) {
      break;
    }
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }

    // Regex literal (JS/TS only); never treat JSX closing `</Tag>`, self-closing `/>`, or single-slash division as regex
    if (
      lang === "js" &&
      ch === "/" &&
      next !== "/" &&
      next !== "*" &&
      !isJsxSelfClosingSlash(line, i) &&
      line[i - 1] !== "<" &&
      isRegexStartContext(line, i) &&
      hasClosingRegexSlashOnLine(line, i)
    ) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }

    // Rust raw strings: r"...", r#"..."#, br#"..."#, cr#"..."#
    if (
      lang === "rust" &&
      (ch === "r" || ((ch === "b" || ch === "c") && next === "r")) &&
      (i === 0 || !/[\w']/.test(line[i - 1]!))
    ) {
      const rIdx = ch === "r" ? i : i + 1;
      let hashEnd = rIdx + 1;
      while (hashEnd < line.length && line[hashEnd] === "#") hashEnd++;
      if (line[hashEnd] === '"') {
        state.rustRawHashes = hashEnd - (rIdx + 1);
        i = hashEnd;
        continue;
      }
    }

    if (ch === "'" && lang !== "json") {
      // In Rust, `'a` / `'static` are lifetimes, not character literals; only treat `'c'` or `'\...'` as char literals
      if (lang === "rust") {
        if (next === "\\" || line[i + 2] === "'") {
          inSingle = true;
        }
        continue;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c" || lang === "go")) {
      state.inBacktick = true;
      continue;
    }

    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1]! += 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1]!;
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }

  state.parenDepth = parenDepth;

  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar,
  };
}

function findBraceBlockEnd(
  lines: string[],
  startIdx: number,
  lang: BraceLang = "c",
): number {
  let depth = 0;
  let seenOpen = false;
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0,
  };
  const maxScan = Math.min(lines.length, startIdx + 2000);

  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      lines[i]!,
      state,
      lang,
      lang === "js" || lang === "go",
      seenOpen,
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    if (seenOpen && depth <= 0) {
      // Inline generic return type like `): Promise<{ ok: boolean }>\n{` closes with `>` before body `{`
      if (lang === "js" && lastCodeChar === ">" && i <= startIdx + 12) {
        seenOpen = false;
        depth = 0;
        continue;
      }
      return i + 1;
    }
    if (!seenOpen && (state.parenDepth ?? 0) <= 0 && endsWithSemi) {
      return i + 1;
    }
    // Multiline signature without opening brace after 40 lines
    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}

function skipBalancedTypeParams(
  lines: string[],
  startLineIdx: number,
  startCol: number,
  maxLines = 6,
): { lineIdx: number; col: number } | null {
  const firstLine = lines[startLineIdx] ?? "";
  let i = startCol;
  while (i < firstLine.length && /\s/.test(firstLine[i]!)) i++;
  if (firstLine[i] !== "<") {
    return { lineIdx: startLineIdx, col: i };
  }

  let angleDepth = 0;
  let parenDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  const limitLine = Math.min(lines.length - 1, startLineIdx + maxLines);

  for (let ln = startLineIdx; ln <= limitLine; ln++) {
    const text = lines[ln] ?? "";
    const fromCol = ln === startLineIdx ? i : 0;
    for (let c = fromCol; c < text.length; c++) {
      const ch = text[c]!;
      const prev = c > 0 ? text[c - 1] : "";
      if (quote) {
        if (ch === "\\") {
          c++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "/" && text[c + 1] === "/") break;
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === "<") {
        angleDepth++;
      } else if (ch === ">" && prev !== "=") {
        angleDepth--;
        if (angleDepth === 0 && parenDepth === 0) {
          return { lineIdx: ln, col: c + 1 };
        }
      }
    }
  }
  return null;
}

function findTypeAliasEqualsPos(
  lines: string[],
  startIdx: number,
): { lineIdx: number; col: number } | null {
  const firstLine = lines[startIdx] ?? "";
  const headMatch = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(
    firstLine,
  );
  if (!headMatch) return null;
  const afterGenerics = skipBalancedTypeParams(
    lines,
    startIdx,
    headMatch[0].length,
  );
  if (!afterGenerics) return null;

  const limitLine = Math.min(lines.length - 1, afterGenerics.lineIdx + 2);
  for (let ln = afterGenerics.lineIdx; ln <= limitLine; ln++) {
    const text = lines[ln] ?? "";
    let col = ln === afterGenerics.lineIdx ? afterGenerics.col : 0;
    while (col < text.length && /\s/.test(text[col]!)) col++;
    if (col < text.length) {
      if (text[col] === "=" && text[col + 1] !== ">") {
        return { lineIdx: ln, col };
      }
      return null;
    }
  }
  return null;
}

function findTypeAliasEnd(lines: string[], startIdx: number): number {
  const eqPos = findTypeAliasEqualsPos(lines, startIdx);
  const eqLineIdx = eqPos ? eqPos.lineIdx : startIdx;
  const eqLine = lines[eqLineIdx] ?? "";
  const rhs = eqPos ? eqLine.slice(eqPos.col + 1) : eqLine;
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0,
  };
  const firstScan = scanBracesOnLine(rhs, state, "js");
  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, eqLineIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return eqLineIdx + 1;
  }

  // Handle multiline union/intersection/mapped types without braces (including semi: false style)
  let endIdx = eqLineIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);
  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation =
      parenBal > 0 ||
      prevLast === "=" ||
      prevLast === "|" ||
      prevLast === "&" ||
      prevLast === "?" ||
      prevLast === ":" ||
      /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }
  return endIdx + 1;
}

function findParenCallEnd(lines: string[], startIdx: number): number {
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0,
  };
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);
  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i]!, state, "js");
    if (openParen > 0) seenParen = true;
    if (seenParen && (state.parenDepth ?? 0) <= 0) {
      return i + 1;
    }
  }
  return startIdx + 1;
}

function hasArrowOrBraceWithin(lines: string[], startIdx: number, maxLookahead = 12): { hasArrow: boolean; hasBrace: boolean } {
  const state: ScanState = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i]!;
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}

function extractTsJsSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const patterns: Array<{ re: RegExp; kind: string; nameGroup: number }> = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1,
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1,
    },
  ];
  const multilineArrowStartRe =
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;

  const typeHeaderRe = /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/;
  const classMemberStartRe =
    /^([ \t]{1,6})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*(\*\s*)?(#?[A-Za-z_$][\w$]*)/;
  const controlKeywords = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete",
  ]);

  const routeRegisterRe =
    /^[ \t]{1,6}(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testSuiteRe = /^(?:describe|suite)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testCaseRe = /^[ \t]{0,4}(?:it|test)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;

  let currentClassEnd = -1;
  let currentClassIndent = -1;
  let currentFnEnd = -1;
  let currentSuiteEnd = -1;
  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment || wasInBacktick) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine =
            p.kind === "type"
              ? findTypeAliasEnd(lines, i)
              : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup]!,
            startLine: i + 1,
            endLine,
            depth: 0,
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          } else if (p.kind === "function" && endLine - (i + 1) >= 40) {
            currentFnEnd = endLine;
          }
          matchedTop = true;
          break;
        }
      }

      if (!matchedTop) {
        const mtp = typeHeaderRe.exec(line);
        if (mtp && mtp[1] && findTypeAliasEqualsPos(lines, i) !== null) {
          const endLine = findTypeAliasEnd(lines, i);
          symbols.push({
            kind: "type",
            name: mtp[1],
            startLine: i + 1,
            endLine,
            depth: 0,
          });
          matchedTop = true;
        }
      }

      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0,
            });
            if (endLine - (i + 1) >= 40) {
              currentFnEnd = endLine;
            }
            matchedTop = true;
          }
        }
      }

      if (!matchedTop) {
        const ms = testSuiteRe.exec(line);
        if (ms && ms[1]) {
          const endLine = findParenCallEnd(lines, i);
          symbols.push({
            kind: "suite",
            name: ms[1].slice(0, 64),
            startLine: i + 1,
            endLine,
            depth: 0,
          });
          currentSuiteEnd = endLine;
          matchedTop = true;
        }
      }
    }

    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = classMemberStartRe.exec(line);
      const indentRaw = mm?.[1];
      const memberName = mm?.[3];
      if (indentRaw && memberName && !controlKeywords.has(memberName)) {
        const indentWidth = indentRaw.replace(/\t/g, "  ").length;
        const afterGen = skipBalancedTypeParams(lines, i, mm[0].length, 4);
        const tailOnLine =
          afterGen && afterGen.lineIdx === i
            ? line.slice(afterGen.col).trimStart()
            : afterGen
              ? (lines[afterGen.lineIdx] ?? "").slice(afterGen.col).trimStart()
              : "";
        const isMethodCallSig = tailOnLine.startsWith("(");
        const restAfterName = line.slice(mm[0].length);
        const isArrowProp =
          !mm[2] &&
          /^\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/.test(
            restAfterName,
          );

        if (isMethodCallSig || isArrowProp) {
          if (currentClassIndent === -1) {
            currentClassIndent = indentWidth;
          }
          if (indentWidth === currentClassIndent) {
            const probe = hasArrowOrBraceWithin(
              lines,
              afterGen ? afterGen.lineIdx : i,
              10,
            );
            if (isMethodCallSig ? probe.hasBrace : probe.hasArrow) {
              const endLine = findBraceBlockEnd(lines, i, "js");
              symbols.push({
                kind: "method",
                name: memberName,
                startLine: i + 1,
                endLine,
                depth: 1,
              });
            }
          }
        }
      }
    } else if (!matchedTop && i + 1 <= currentFnEnd) {
      const mr = routeRegisterRe.exec(line);
      if (mr && mr[1] && mr[2]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "route",
          name: `${mr[1].toUpperCase()} ${mr[2]}`,
          startLine: i + 1,
          endLine,
          depth: 1,
        });
      }
    } else if (!matchedTop) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[1]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "test",
          name: mt[1].slice(0, 64),
          startLine: i + 1,
          endLine,
          depth: i + 1 <= currentSuiteEnd ? 1 : 0,
        });
      }
    }
  }

  return symbols;
}

function isPythonFStringPrefix(line: string, quoteIdx: number): boolean {
  let k = quoteIdx - 1;
  while (k >= 0 && /[A-Za-z]/.test(line[k]!)) k--;
  if (k >= 0 && /[0-9_]/.test(line[k]!)) return false;
  const prefix = line.slice(k + 1, quoteIdx).toLowerCase();
  return prefix === "f" || prefix === "fr" || prefix === "rf";
}

function extractPythonSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const indentOf = (l: string) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;

  // Pre-compute whether each line continues the previous logical line: it starts
  // inside a triple-quoted string, inside open brackets (multi-line signatures,
  // calls, literals), inside a Python 3.12+ f-string expression, or after a
  // backslash continuation.
  const isContinuation = new Array<boolean>(lines.length).fill(false);
  const inStringContinuation = new Array<boolean>(lines.length).fill(false);
  let activeQuote: '"""' | "'''" | null = null;
  let activeSingleQuote: '"' | "'" | null = null;
  let activeSingleIsFString = false;
  let bracketDepth = 0;
  let backslashContinued = false;
  const fExprStack: Array<{ quote: '"' | "'"; braceDepth: number; baseBracketDepth: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    inStringContinuation[i] =
      activeQuote !== null || activeSingleQuote !== null || backslashContinued;
    // In Python, `def`/`async def`/`class` are statements and cannot appear
    // inside open brackets or an f-string expression. Recover from mid-edit
    // unclosed brackets so subsequent symbols in the file are preserved.
    if (
      !inStringContinuation[i] &&
      (bracketDepth > 0 || fExprStack.length > 0) &&
      re.test(line)
    ) {
      bracketDepth = 0;
      fExprStack.length = 0;
      const defIndent = indentOf(line);
      for (let k = i - 1; k >= 0; k--) {
        if (inStringContinuation[k]) break;
        const t = lines[k]!.trim();
        if (!t || t.startsWith("#")) {
          isContinuation[k] = false;
          continue;
        }
        if (t.startsWith("@") && indentOf(lines[k]!) === defIndent) {
          isContinuation[k] = false;
          continue;
        }
        break;
      }
    }
    isContinuation[i] =
      inStringContinuation[i]! || bracketDepth > 0 || fExprStack.length > 0;
    backslashContinued = false;
    let j = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else if (activeSingleQuote) {
        if (line[j] === "\\") {
          if (j === line.length - 1) {
            backslashContinued = true;
            break;
          }
          j += 2;
          continue;
        }
        if (activeSingleIsFString) {
          if (line[j] === "{") {
            if (line[j + 1] === "{") {
              j += 2;
              continue;
            }
            fExprStack.push({
              quote: activeSingleQuote,
              braceDepth: 1,
              baseBracketDepth: bracketDepth,
            });
            activeSingleQuote = null;
            activeSingleIsFString = false;
            j++;
            continue;
          }
          if (line[j] === "}" && line[j + 1] === "}") {
            j += 2;
            continue;
          }
        }
        if (line[j] === activeSingleQuote) {
          activeSingleQuote = null;
          activeSingleIsFString = false;
          j++;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          activeSingleQuote = line[j] === '"' ? '"' : "'";
          activeSingleIsFString = isPythonFStringPrefix(line, j);
          j++;
          continue;
        }
        if (fExprStack.length > 0) {
          const top = fExprStack[fExprStack.length - 1]!;
          if (
            top.braceDepth === 1 &&
            bracketDepth === top.baseBracketDepth &&
            line[j] === ":" &&
            line[j + 1] !== "="
          ) {
            // Format spec (e.g. f"{x:'>10}" or f"{x:{w}}"): scan to matching `}`.
            let specDepth = 1;
            j++;
            while (j < line.length && specDepth > 0) {
              if (line[j] === "\\") {
                j += 2;
                continue;
              }
              if (line[j] === "{") specDepth++;
              else if (line[j] === "}") specDepth--;
              j++;
            }
            if (specDepth === 0) {
              fExprStack.pop();
              activeSingleQuote = top.quote;
              activeSingleIsFString = true;
            }
            continue;
          }
          if (line[j] === "{") {
            top.braceDepth++;
            bracketDepth++;
            j++;
            continue;
          }
          if (line[j] === "}") {
            if (top.braceDepth === 1) {
              fExprStack.pop();
              activeSingleQuote = top.quote;
              activeSingleIsFString = true;
              j++;
              continue;
            }
            top.braceDepth--;
            bracketDepth = Math.max(0, bracketDepth - 1);
            j++;
            continue;
          }
        }
        if (line[j] === "(" || line[j] === "[" || line[j] === "{") bracketDepth++;
        else if (line[j] === ")" || line[j] === "]" || line[j] === "}") {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (line[j] === "\\" && j === line.length - 1) backslashContinued = true;
        j++;
      }
    }
    // Single-line string without trailing backslash does not span lines in Python
    if (activeSingleQuote && !backslashContinued) {
      activeSingleQuote = null;
      activeSingleIsFString = false;
    }
  }

  const raw: Array<{ indent: number; kind: string; name: string; defIdx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (isContinuation[i]) continue;
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3]!, defIdx: i });
  }

  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx]!;
    // Decorators directly above the def belong to the symbol.
    let startIdx = item.defIdx;
    for (let j = item.defIdx - 1; j >= 0; j--) {
      if (isContinuation[j] || !lines[j]!.trim()) continue;
      const trimmed = lines[j]!.trimStart();
      if (trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("@") || indentOf(lines[j]!) !== item.indent) break;
      startIdx = j;
    }
    let endIdx = lines.length - 1;
    for (let j = item.defIdx + 1; j < lines.length; j++) {
      if (isContinuation[j]) continue;
      const l = lines[j]!;
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (indentOf(l) <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    // Trailing blank lines and comments at or left of the def indent introduce
    // what follows, not this body.
    while (endIdx > item.defIdx) {
      const trimmed = lines[endIdx]!.trim();
      if (
        trimmed &&
        !(
          !isContinuation[endIdx] &&
          trimmed.startsWith("#") &&
          indentOf(lines[endIdx]!) <= item.indent
        )
      ) {
        break;
      }
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      depth: item.indent > 0 ? 1 : 0,
    });
  }

  return symbols;
}

function stripLeadingGdAnnotations(text: string): string {
  let rest = text;
  while (rest.startsWith("@")) {
    const m = /^@[A-Za-z_]\w*/.exec(rest);
    if (!m) break;
    let idx = m[0].length;
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "\t")) idx++;
    if (rest[idx] === "(") {
      let depth = 0;
      let quote: string | null = null;
      while (idx < rest.length) {
        const ch = rest[idx]!;
        if (quote) {
          if (ch === "\\") {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              idx++;
              break;
            }
          }
        }
        idx++;
      }
    }
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "\t")) idx++;
    rest = rest.slice(idx);
  }
  return rest;
}

function extractGdScriptSymbols(rawLines: string[]): SymbolEntry[] {
  const lines = rawLines.map((l, idx) => {
    const clean = l.endsWith("\r") ? l.slice(0, -1) : l;
    return idx === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });

  interface GdLineInfo {
    startsInTriple: boolean;
    openBrace: number;
    closeBrace: number;
    openParen: number;
    closeParen: number;
    hasCode: boolean;
  }

  const info: GdLineInfo[] = new Array<GdLineInfo>(lines.length);
  let activeTriple: '"""' | "'''" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const startsInTriple = activeTriple !== null;
    let openBrace = 0;
    let closeBrace = 0;
    let openParen = 0;
    let closeParen = 0;
    let hasCode = startsInTriple;

    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        const ch = line[j]!;
        if (ch === "#") break;
        if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
          activeTriple = line.startsWith('"""', j) ? '"""' : "'''";
          hasCode = true;
          j += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          hasCode = true;
          j++;
          while (j < line.length && line[j] !== ch) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          if (j < line.length) j++;
          continue;
        }
        if (ch !== " " && ch !== "\t") {
          hasCode = true;
          if (ch === "{") openBrace++;
          else if (ch === "}") closeBrace++;
          else if (ch === "(") openParen++;
          else if (ch === ")") closeParen++;
        }
        j++;
      }
    }

    info[i] = {
      startsInTriple,
      openBrace,
      closeBrace,
      openParen,
      closeParen,
      hasCode,
    };
  }

  type GdRawKind = "class_name" | "class" | "func" | "signal" | "enum";
  const raw: Array<{
    indent: number;
    rawKind: GdRawKind;
    name: string;
    startIdx: number;
  }> = [];

  const classNameRe = /^class_name\s+([A-Za-z_]\w*)\b/;
  const classRe = /^class\s+([A-Za-z_]\w*)\b/;
  const funcRe = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const signalRe = /^signal\s+([A-Za-z_]\w*)\b/;
  const enumRe = /^enum(?:\s+([A-Za-z_]\w*))?\s*(?:\{|$|#)/;

  for (let i = 0; i < lines.length; i++) {
    if (info[i]!.startsInTriple) continue;
    const line = lines[i]!;
    const indentStr = /^[ \t]*/.exec(line)?.[0] ?? "";
    const afterIndent = line.slice(indentStr.length);
    if (!afterIndent || afterIndent.startsWith("#")) continue;

    const rest = stripLeadingGdAnnotations(afterIndent);
    if (!rest || rest.startsWith("#")) continue;

    const indent = indentStr.replace(/\t/g, "    ").length;

    let m = classNameRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class_name", name: m[1], startIdx: i });
      continue;
    }

    m = classRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class", name: m[1], startIdx: i });
      continue;
    }

    m = funcRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "func", name: m[1], startIdx: i });
      continue;
    }

    m = signalRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "signal", name: m[1], startIdx: i });
      continue;
    }

    m = enumRe.exec(rest);
    if (m) {
      // Anonymous `enum` without `{` on same line must open `{` on next code line
      if (!m[1] && info[i]!.openBrace === 0) {
        let nextCodeIdx = i + 1;
        while (nextCodeIdx < lines.length && !info[nextCodeIdx]!.hasCode) {
          nextCodeIdx++;
        }
        if (nextCodeIdx >= lines.length || info[nextCodeIdx]!.openBrace === 0) {
          continue;
        }
      }
      raw.push({
        indent,
        rawKind: "enum",
        name: m[1] ?? "<anonymous>",
        startIdx: i,
      });
    }
  }

  const symbols: SymbolEntry[] = [];
  const classStack: Array<{ indent: number; endLine: number }> = [];

  for (const item of raw) {
    let endIdx = item.startIdx;

    if (item.rawKind === "class_name") {
      endIdx = item.startIdx;
    } else if (item.rawKind === "signal") {
      let parenDepth = info[item.startIdx]!.openParen - info[item.startIdx]!.closeParen;
      const maxSigScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && endIdx < maxSigScan) {
        endIdx++;
        parenDepth += info[endIdx]!.openParen - info[endIdx]!.closeParen;
      }
      if (parenDepth > 0) endIdx = item.startIdx;
    } else if (item.rawKind === "enum") {
      let braceDepth = 0;
      let seenOpen = false;
      const maxEnumScan = Math.min(lines.length - 1, item.startIdx + 500);
      for (let k = item.startIdx; k <= maxEnumScan; k++) {
        const li = info[k]!;
        if (li.openBrace > 0) seenOpen = true;
        braceDepth += li.openBrace - li.closeBrace;
        if (seenOpen && braceDepth <= 0) {
          endIdx = k;
          break;
        }
        if (!seenOpen && k > item.startIdx && li.hasCode && li.openBrace === 0) {
          break;
        }
      }
      if (seenOpen && braceDepth > 0) {
        endIdx = maxEnumScan;
      }
    } else {
      // `class` or `func` / `static func`: advance past multiline signature parens first
      let headerEndIdx = item.startIdx;
      let parenDepth = info[item.startIdx]!.openParen - info[item.startIdx]!.closeParen;
      const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
        headerEndIdx++;
        parenDepth += info[headerEndIdx]!.openParen - info[headerEndIdx]!.closeParen;
      }
      if (parenDepth > 0) headerEndIdx = item.startIdx;

      endIdx = lines.length - 1;
      for (let j = headerEndIdx + 1; j < lines.length; j++) {
        if (info[j]!.startsInTriple) continue;
        const l = lines[j]!;
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
        if (curIndent <= item.indent) {
          endIdx = j - 1;
          break;
        }
      }

      while (endIdx > headerEndIdx) {
        if (info[endIdx]!.startsInTriple) break;
        const endLineStr = lines[endIdx]!;
        const endTrimmed = endLineStr.trim();
        if (!endTrimmed) {
          endIdx--;
          continue;
        }
        if (endTrimmed.startsWith("#")) {
          const commentIndent = (/^[ \t]*/.exec(endLineStr)?.[0] ?? "").replace(
            /\t/g,
            "    ",
          ).length;
          if (commentIndent <= item.indent) {
            endIdx--;
            continue;
          }
        }
        break;
      }
    }

    const startLine = item.startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);

    while (
      classStack.length > 0 &&
      (classStack[classStack.length - 1]!.endLine < startLine ||
        classStack[classStack.length - 1]!.indent >= item.indent)
    ) {
      classStack.pop();
    }

    const depth =
      classStack.length > 0
        ? classStack.length
        : item.indent > 0
          ? Math.max(1, Math.floor(item.indent / 4))
          : 0;

    const kind =
      item.rawKind === "func"
        ? item.indent > 0
          ? "method"
          : "function"
        : item.rawKind;

    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth,
    });

    if (item.rawKind === "class") {
      classStack.push({ indent: item.indent, endLine });
    }
  }

  return symbols;
}

function extractGoSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*(?:\[[^\]]*\])?)\s+(struct|interface)\b/;
  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "go");
    if (wasInComment || wasInBacktick) continue;

    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0,
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0,
      });
    }
  }
  return symbols;
}

function extractRustSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re =
    /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)(?:\s+|\s*(?=<))([A-Za-z_<][\w:<>,+'&\s]*?)(?:\s*[\({;]|$)/;
  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    const wasInRaw = (commentState.rustRawHashes ?? -1) >= 0;
    scanBracesOnLine(line, commentState, "rust");
    if (wasInComment || wasInRaw) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1]!.length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "rust"),
      depth: indent > 0 ? 1 : 0,
    });
  }
  return symbols;
}

function extractCLikeSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const typeRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial)\s+)*(class|interface|enum|struct|record|protocol|namespace)\s+([A-Za-z_]\w*)/;
  const kwFuncRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  // C / C++ / Java / C# functions and class methods (return-type + name + '(')
  const cMethodRe =
    /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&]*?\s+)([A-Za-z_~][\w:]*)\s*\([^;]*$/;
  const excludedNames = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case",
  ]);

  const commentState: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }

    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0,
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0,
      });
      continue;
    }

    // Match C/C++/Java/C# function/method definitions that open a brace block
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !trimmed.includes("=")) {
      const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "c"),
          depth: indented ? 1 : 0,
        });
      }
    }
  }
  return symbols;
}

function extractShellSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0,
    });
  }
  return symbols;
}

function extractMarkdownSymbols(lines: string[]): SymbolEntry[] {
  const raw: Array<{ level: number; name: string; startLine: number }> = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const seq = fenceMatch[1]!;
      const ch = seq[0] as "`" | "~";
      const rest = fenceMatch[2] ?? "";
      if (fenceChar === null) {
        // CommonMark: backtick fence info strings cannot contain backticks (e.g. inline ```code```)
        if (ch === "~" || !rest.includes("`")) {
          fenceChar = ch;
          fenceLen = seq.length;
          continue;
        }
      } else if (ch === fenceChar && seq.length >= fenceLen && /^[ \t]*$/.test(rest)) {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
    }
    if (fenceChar !== null) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({ level: m[1].length, name: m[2], startLine: i + 1 });
    }
  }

  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j]!.level <= item.level) {
        endLine = raw[j]!.startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1,
    };
  });
}

function extractJsonYamlSymbols(lines: string[], isJson: boolean): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  if (isJson) {
    // Track structural JSON container depth (`{` vs `[`) outside strings so 0-indent,
    // 2/4-space, and tab-formatted root objects emit exact root keys while root arrays skip element duplicates.
    const stack: Array<"{" | "["> = [];
    const activeSymStack: Array<SymbolEntry | null> = [];
    let inString = false;
    let escape = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c]!;
        if (escape) {
          escape = false;
          continue;
        }
        if (inString) {
          if (ch === "\\") escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        // JSONC comments
        if (ch === "/" && line[c + 1] === "/") break;
        if (ch === '"') {
          if (stack.length === 1 && stack[0] === "{") {
            let endQuote = c + 1;
            let strEsc = false;
            while (endQuote < line.length) {
              const sc = line[endQuote]!;
              if (strEsc) strEsc = false;
              else if (sc === "\\") strEsc = true;
              else if (sc === '"') break;
              endQuote++;
            }
            if (endQuote < line.length) {
              const keyName = line.slice(c + 1, endQuote);
              let colonIdx = endQuote + 1;
              while (colonIdx < line.length && /\s/.test(line[colonIdx]!)) {
                colonIdx++;
              }
              if (line[colonIdx] === ":") {
                if (activeSymStack[0]) {
                  activeSymStack[0].endLine = Math.max(
                    activeSymStack[0].startLine,
                    i,
                  );
                }
                const entry: SymbolEntry = {
                  kind: "key",
                  name: keyName,
                  startLine: i + 1,
                  endLine: i + 1,
                  depth: 0,
                };
                symbols.push(entry);
                activeSymStack[0] = entry;
                c = colonIdx;
                continue;
              }
            }
          }
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          stack.push(ch);
          if (stack.length === 1) activeSymStack[0] = null;
        } else if (ch === "}" || ch === "]") {
          if (stack.length === 1 && activeSymStack[0]) {
            activeSymStack[0].endLine = Math.max(
              activeSymStack[0].startLine,
              i > activeSymStack[0].startLine - 1 ? i : i + 1,
            );
            activeSymStack[0] = null;
          }
          stack.pop();
        } else if (ch === "," && stack.length === 1 && activeSymStack[0]) {
          activeSymStack[0].endLine = i + 1;
          activeSymStack[0] = null;
        }
      }
    }
    if (activeSymStack[0]) {
      activeSymStack[0].endLine = Math.max(
        activeSymStack[0].startLine,
        lines.length,
      );
    }
    return symbols;
  }

  // YAML top-level keys (including quoted keys like `"on":` in GitHub Actions, while rejecting bare `https://...`)
  const re = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:(?:\s*(?:#.*)?$|\s+\S)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    const keyName = m?.[1] || m?.[2] || m?.[3];
    if (keyName) {
      symbols.push({
        kind: "key",
        name: keyName,
        startLine: i + 1,
        endLine: i + 1,
        depth: 0,
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx]!;
    let endLine =
      idx + 1 < symbols.length ? symbols[idx + 1]!.startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}

function extractCssSymbols(lines: string[], compactOnly = false): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
  };
  let braceDepth = 0;

  const atRuleRe = /^@(layer|media|keyframes|supports|container|font-face|theme)\b([^{;]*)/i;
  const tokenBlockRe =
    /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const sectionCommentRe = /^\/\*\s*[=\-*#]*\s*([^*/=][^*/]{1,70}?)\s*[=\-*#]*\s*\*\/$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;

    if (!wasInComment && braceDepth === 0 && trimmed) {
      const cm = sectionCommentRe.exec(trimmed);
      if (cm && cm[1] && /[A-Za-z0-9\u4e00-\u9fff]/.test(cm[1])) {
        symbols.push({
          kind: "section",
          name: cm[1].trim().slice(0, 64),
          startLine: i + 1,
          endLine: i + 1,
          depth: 0,
        });
      } else {
        const am = atRuleRe.exec(trimmed);
        if (am && am[1]) {
          const endLine = trimmed.includes("{")
            ? findBraceBlockEnd(lines, i, "c")
            : i + 1;
          const rest = (am[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
          symbols.push({
            kind: `@${am[1].toLowerCase()}`,
            name: rest || `@${am[1].toLowerCase()}`,
            startLine: i + 1,
            endLine,
            depth: 0,
          });
        } else {
          const tm = tokenBlockRe.exec(trimmed);
          if (tm && tm[1]) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            const header = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tm[1],
              startLine: i + 1,
              endLine,
              depth: 0,
            });
          }
        }
      }
    }

    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }

  // If few structural blocks were found in a standalone CSS/SCSS file, sample top-level rule groups
  if (!compactOnly && symbols.length < 10) {
    const fallbackState: ScanState = {
      inBlockComment: false,
      templateExprStack: [],
      inBacktick: false,
    };
    let d = 0;
    let lastAddedLine = -999;
    const seen = new Set(symbols.map((s) => s.startLine));
    for (let i = 0; i < lines.length && symbols.length < 40; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      const wasInComment = fallbackState.inBlockComment;
      if (
        !wasInComment &&
        d === 0 &&
        !seen.has(i + 1) &&
        i - lastAddedLine >= 10 &&
        /^[.#\[a-zA-Z*:]/.test(trimmed) &&
        trimmed.includes("{") &&
        !trimmed.startsWith("@")
      ) {
        const sel = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
        if (sel) {
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: "rule",
            name: sel,
            startLine: i + 1,
            endLine,
            depth: 0,
          });
          lastAddedLine = i;
        }
      }
      const { open, close } = scanBracesOnLine(line, fallbackState, "c");
      d = Math.max(0, d + open - close);
    }
    symbols.sort((a, b) => a.startLine - b.startLine);
  }

  return symbols;
}

function stripSqlCommentsForHeader(raw: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inBacktick) {
      out += ch;
      if (ch === "`" && next === "`") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "`") inBacktick = false;
      i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "`") inBacktick = true;
    out += ch;
    i++;
  }
  return out;
}

function extractSqlQualifiedName(rest: string): string | null {
  const parts: string[] = [];
  let i = 0;
  const len = rest.length;

  while (i < len && parts.length < 3) {
    while (i < len && /\s/.test(rest[i]!)) i++;
    if (i >= len) break;
    const ch = rest[i]!;
    if (ch === '"') {
      i++;
      let buf = "";
      while (i < len) {
        if (rest[i] === '"' && rest[i + 1] === '"') {
          buf += '"';
          i += 2;
          continue;
        }
        if (rest[i] === '"') {
          i++;
          break;
        }
        buf += rest[i]!;
        i++;
      }
      if (!buf) break;
      parts.push(buf);
    } else if (ch === "`") {
      i++;
      let buf = "";
      while (i < len) {
        if (rest[i] === "`" && rest[i + 1] === "`") {
          buf += "`";
          i += 2;
          continue;
        }
        if (rest[i] === "`") {
          i++;
          break;
        }
        buf += rest[i]!;
        i++;
      }
      if (!buf) break;
      parts.push(buf);
    } else if (ch === "[") {
      i++;
      const start = i;
      while (i < len && rest[i] !== "]") i++;
      const buf = rest.slice(start, i).trim();
      if (i < len && rest[i] === "]") i++;
      if (!buf) break;
      parts.push(buf);
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[\w$]/.test(rest[i]!)) i++;
      parts.push(rest.slice(start, i));
    } else {
      break;
    }

    let k = i;
    while (k < len && /\s/.test(rest[k]!)) k++;
    if (rest[k] === ".") {
      i = k + 1;
    } else {
      break;
    }
  }

  return parts.length > 0 ? parts.join(".") : null;
}

function parseSqlDdlHeader(rawHeader: string): { kind: string; name: string } | null {
  const cleaned = stripSqlCommentsForHeader(rawHeader).replace(/\s+/g, " ").trimStart();
  const createMatch =
    /^CREATE\s+(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMP(?:ORARY)?|UNLOGGED|EXTERNAL|VIRTUAL|MATERIALIZED|UNIQUE|FULLTEXT|SPATIAL|CLUSTERED|NONCLUSTERED|TRANSIENT|SECURE)\s+)*(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA|SEQUENCE)\b\s*(.*)$/i.exec(
      cleaned,
    );
  if (createMatch && createMatch[1]) {
    const kind = createMatch[1].toLowerCase();
    let rest = (createMatch[2] ?? "").trimStart();
    for (let pass = 0; pass < 3; pass++) {
      const nextRest = rest
        .replace(/^CONCURRENTLY\b\s*/i, "")
        .replace(/^IF\s+NOT\s+EXISTS\b\s*/i, "")
        .replace(kind === "schema" ? /^AUTHORIZATION\b\s*/i : /^$/, "");
      if (nextRest === rest) break;
      rest = nextRest;
    }
    if (kind === "index" && /^ON\b\s+/i.test(rest)) {
      const tbl = extractSqlQualifiedName(rest.replace(/^ON\b\s+/i, ""));
      return tbl ? { kind, name: `on ${tbl}` } : null;
    }
    const name = extractSqlQualifiedName(rest);
    return name ? { kind, name } : null;
  }

  const alterMatch = /^ALTER\s+(?:FOREIGN\s+)?TABLE\b\s*(.*)$/i.exec(cleaned);
  if (alterMatch) {
    let rest = (alterMatch[1] ?? "").trimStart();
    for (let pass = 0; pass < 2; pass++) {
      const nextRest = rest
        .replace(/^IF\s+EXISTS\b\s*/i, "")
        .replace(/^ONLY\b\s*/i, "");
      if (nextRest === rest) break;
      rest = nextRest;
    }
    const name = extractSqlQualifiedName(rest);
    return name ? { kind: "alter", name } : null;
  }

  return null;
}

function extractSqlSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  let inBlockComment = false;
  let dollarTag: string | null = null;
  let inSingleQuote = false;
  let singleQuoteBackslash = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let parenDepth = 0;
  let beginDepth = 0;
  let caseDepth = 0;
  let atStatementStart = true;
  let activeSym: SymbolEntry | null = null;
  let lastCodeLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let col = 0;
    let seenCodeOnLine = false;

    while (col < line.length) {
      const ch = line[col]!;
      const next = line[col + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          col += 2;
        } else {
          col++;
        }
        continue;
      }

      if (dollarTag !== null) {
        if (ch === "$" && line.startsWith(dollarTag, col)) {
          col += dollarTag.length;
          dollarTag = null;
          lastCodeLine = i + 1;
          seenCodeOnLine = true;
        } else {
          col++;
        }
        continue;
      }

      if (inSingleQuote) {
        if (singleQuoteBackslash && ch === "\\") {
          col += 2;
          continue;
        }
        if (ch === "'" && next === "'") {
          col += 2;
          continue;
        }
        if (ch === "'") {
          inSingleQuote = false;
          singleQuoteBackslash = false;
          lastCodeLine = i + 1;
        }
        col++;
        continue;
      }

      if (inDoubleQuote) {
        if (ch === '"' && next === '"') {
          col += 2;
          continue;
        }
        if (ch === '"') {
          inDoubleQuote = false;
          lastCodeLine = i + 1;
        }
        col++;
        continue;
      }

      if (inBacktick) {
        if (ch === "`" && next === "`") {
          col += 2;
          continue;
        }
        if (ch === "`") {
          inBacktick = false;
          lastCodeLine = i + 1;
        }
        col++;
        continue;
      }

      if (/\s/.test(ch)) {
        col++;
        continue;
      }

      if (ch === "-" && next === "-") {
        break;
      }

      if (ch === "/" && next === "*") {
        inBlockComment = true;
        col += 2;
        continue;
      }

      // psql meta-commands (e.g. \connect, \set) at line/statement start do not require ';'
      if (!seenCodeOnLine && atStatementStart && ch === "\\") {
        break;
      }

      // T-SQL GO batch separator on its own line
      if (
        !seenCodeOnLine &&
        parenDepth === 0 &&
        beginDepth === 0 &&
        /^GO\b\s*(?:--.*)?$/i.test(line.slice(col))
      ) {
        if (activeSym) {
          activeSym.endLine = Math.max(activeSym.startLine, lastCodeLine);
          activeSym = null;
        }
        atStatementStart = true;
        break;
      }

      if (
        atStatementStart ||
        (!seenCodeOnLine &&
          parenDepth === 0 &&
          beginDepth === 0 &&
          /^(?:CREATE|ALTER)\b/i.test(line.slice(col)))
      ) {
        const headerWindow = [
          line.slice(col),
          lines[i + 1] ?? "",
          lines[i + 2] ?? "",
          lines[i + 3] ?? "",
        ].join("\n");
        const ddl = parseSqlDdlHeader(headerWindow);
        if (ddl) {
          if (activeSym) {
            activeSym.endLine = Math.max(activeSym.startLine, lastCodeLine);
          }
          activeSym = {
            kind: ddl.kind,
            name: ddl.name,
            startLine: i + 1,
            endLine: i + 1,
            depth: 0,
          };
          symbols.push(activeSym);
          parenDepth = 0;
          beginDepth = 0;
          caseDepth = 0;
          atStatementStart = false;
        } else if (atStatementStart) {
          atStatementStart = false;
        }
      }

      seenCodeOnLine = true;
      lastCodeLine = i + 1;

      if (ch === "$") {
        const dm = /^\$(?:[A-Za-z_]\w*)?\$/.exec(line.slice(col));
        if (dm) {
          dollarTag = dm[0];
          col += dm[0].length;
          continue;
        }
      }

      if (
        (ch === "E" || ch === "e") &&
        next === "'" &&
        (col === 0 || !/[\w$]/.test(line[col - 1]!))
      ) {
        inSingleQuote = true;
        singleQuoteBackslash = true;
        col += 2;
        continue;
      }

      if (ch === "'") {
        inSingleQuote = true;
        singleQuoteBackslash = false;
        col++;
        continue;
      }

      if (ch === '"') {
        inDoubleQuote = true;
        col++;
        continue;
      }

      if (ch === "`") {
        inBacktick = true;
        col++;
        continue;
      }

      if (ch === "(") {
        parenDepth++;
        col++;
        continue;
      }
      if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        col++;
        continue;
      }

      if (
        activeSym &&
        (activeSym.kind === "function" ||
          activeSym.kind === "procedure" ||
          activeSym.kind === "trigger") &&
        /[A-Za-z_]/.test(ch) &&
        (col === 0 || !/[\w$]/.test(line[col - 1]!))
      ) {
        const wordMatch = /^[A-Za-z_]\w*/.exec(line.slice(col));
        if (wordMatch) {
          const upper = wordMatch[0].toUpperCase();
          const afterWord = line.slice(col + wordMatch[0].length);
          if (upper === "BEGIN" && !/^\s*(?:TRANSACTION\b|WORK\b)?\s*;/.test(afterWord)) {
            beginDepth++;
          } else if (upper === "CASE" && parenDepth === 0) {
            caseDepth++;
          } else if (upper === "END") {
            if (/^\s+CASE\b/i.test(afterWord)) {
              caseDepth = Math.max(0, caseDepth - 1);
            } else if (!/^\s+(?:IF|LOOP|WHILE|REPEAT)\b/i.test(afterWord)) {
              if (caseDepth > 0 && !/^\s*;/.test(afterWord)) {
                caseDepth--;
              } else {
                beginDepth = Math.max(0, beginDepth - 1);
              }
            }
          }
          col += wordMatch[0].length;
          continue;
        }
      }

      if (ch === ";" && parenDepth === 0 && beginDepth === 0) {
        if (activeSym) {
          activeSym.endLine = i + 1;
          activeSym = null;
        }
        caseDepth = 0;
        atStatementStart = true;
        col++;
        continue;
      }

      col++;
    }
  }

  if (activeSym) {
    activeSym.endLine = Math.max(activeSym.startLine, lastCodeLine);
  }

  return symbols;
}

function hasProtoOpenBraceSoon(lines: string[], lineIdx: number, restAfterName: string): boolean {
  const stripInlineComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/, "").trim();
  const tail = stripInlineComments(restAfterName);
  if (tail.startsWith("{")) return true;
  if (tail.length > 0) return false;
  for (let k = lineIdx + 1; k < Math.min(lines.length, lineIdx + 4); k++) {
    const nextTrim = stripInlineComments(lines[k] ?? "");
    if (!nextTrim) continue;
    return nextTrim.startsWith("{");
  }
  return false;
}

function extractProtoSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const state: ScanState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0,
  };
  let braceDepth = 0;

  const pkgRe = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/;
  const blockDeclRe = /^\s*(message|service|enum|oneof|extend)\s+(\.?[A-Za-z_][\w.]*)(.*)$/;
  const rpcRe = /^\s*rpc\s+([A-Za-z_]\w*)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const wasInComment = state.inBlockComment;
    const depthBeforeLine = braceDepth;
    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);

    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    if (depthBeforeLine === 0) {
      const pm = pkgRe.exec(line);
      if (pm && pm[1]) {
        symbols.push({
          kind: "package",
          name: pm[1],
          startLine: i + 1,
          endLine: i + 1,
          depth: 0,
        });
        continue;
      }
    }

    const bm = blockDeclRe.exec(line);
    if (bm && bm[1] && bm[2] && hasProtoOpenBraceSoon(lines, i, bm[3] ?? "")) {
      symbols.push({
        kind: bm[1],
        name: bm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: Math.min(2, depthBeforeLine),
      });
      continue;
    }

    const rm = rpcRe.exec(line);
    if (rm && rm[1] && depthBeforeLine >= 1) {
      symbols.push({
        kind: "rpc",
        name: rm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: Math.min(2, depthBeforeLine),
      });
    }
  }

  return symbols;
}

interface GraphqlScanState {
  inBlockString: boolean;
}

function scanGraphqlLine(
  line: string,
  state: GraphqlScanState,
): {
  code: string;
  openBrace: number;
  closeBrace: number;
  openParen: number;
  closeParen: number;
  lastTokenChar: string;
} {
  let code = "";
  let openBrace = 0;
  let closeBrace = 0;
  let openParen = 0;
  let closeParen = 0;
  let lastTokenChar = "";
  let inSingleLineStr = false;
  let i = 0;

  while (i < line.length) {
    if (state.inBlockString) {
      if (line[i] === "\\" && line.startsWith('"""', i + 1)) {
        i += 4;
        continue;
      }
      if (line.startsWith('"""', i)) {
        state.inBlockString = false;
        i += 3;
        continue;
      }
      i++;
      continue;
    }

    if (inSingleLineStr) {
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line[i] === '"') {
        inSingleLineStr = false;
        lastTokenChar = '"';
      }
      i++;
      continue;
    }

    if (line[i] === "#") break;

    if (line.startsWith('"""', i)) {
      state.inBlockString = true;
      code += " ";
      i += 3;
      continue;
    }

    if (line[i] === '"') {
      inSingleLineStr = true;
      code += '""';
      i++;
      continue;
    }

    const ch = line[i]!;
    code += ch;
    if (ch === "{") openBrace++;
    else if (ch === "}") closeBrace++;
    else if (ch === "(") openParen++;
    else if (ch === ")") closeParen++;
    if (!/\s/.test(ch)) lastTokenChar = ch;
    i++;
  }

  return { code, openBrace, closeBrace, openParen, closeParen, lastTokenChar };
}

function findGraphqlDefinitionEnd(
  lines: string[],
  startIdx: number,
  expectsBraceBlock: boolean,
): number {
  const state: GraphqlScanState = { inBlockString: false };
  let braceDepth = 0;
  let parenDepth = 0;
  let seenBrace = false;
  let endLineIdx = startIdx;
  let prevLastChar = "";
  const maxScan = Math.min(lines.length, startIdx + 2000);

  const topDefStartRe =
    /^(?:extend\s+)?(?:type|input|interface|enum|union|scalar|directive|schema|fragment|query|mutation|subscription)\b/;

  for (let i = startIdx; i < maxScan; i++) {
    const wasInBlockStr = state.inBlockString;
    const scan = scanGraphqlLine(lines[i]!, state);
    const trimmedCode = scan.code.trim();

    if (i > startIdx && !seenBrace && parenDepth === 0 && !wasInBlockStr && !state.inBlockString) {
      if (!trimmedCode) {
        if (!expectsBraceBlock && prevLastChar !== "=" && prevLastChar !== "|") {
          return endLineIdx + 1;
        }
        continue;
      }
      if (topDefStartRe.test(trimmedCode)) {
        return endLineIdx + 1;
      }
      if (
        !expectsBraceBlock &&
        prevLastChar !== "=" &&
        prevLastChar !== "|" &&
        !trimmedCode.startsWith("|") &&
        !trimmedCode.startsWith("@") &&
        !trimmedCode.startsWith("=") &&
        !/^(?:on|repeatable)\b/.test(trimmedCode)
      ) {
        return endLineIdx + 1;
      }
    }

    if (scan.openBrace > 0) seenBrace = true;
    braceDepth += scan.openBrace - scan.closeBrace;
    parenDepth = Math.max(0, parenDepth + scan.openParen - scan.closeParen);

    if (trimmedCode || wasInBlockStr || state.inBlockString) {
      endLineIdx = i;
    }
    if (scan.lastTokenChar) {
      prevLastChar = scan.lastTokenChar;
    }

    if (seenBrace && braceDepth <= 0 && parenDepth <= 0) {
      return i + 1;
    }
  }

  return endLineIdx + 1;
}

function extractGraphqlSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const state: GraphqlScanState = { inBlockString: false };
  let braceDepth = 0;
  let parenDepth = 0;

  const namedTypeRe =
    /^(?:extend\s+)?(type|input|interface|enum|union|scalar)\s+([A-Za-z_]\w*)\b/;
  const directiveRe = /^directive\s+(@[A-Za-z_]\w*)\b/;
  const schemaRe = /^(?:extend\s+)?schema\b(?:\s*@|\s*\{|\s*$)/;
  const fragmentRe = /^fragment\s+([A-Za-z_]\w*)\s+on\s+[A-Za-z_]\w*/;
  const opRe = /^(query|mutation|subscription)\b(?:\s+([A-Za-z_]\w*))?\s*(?:[\({@]|$)/;

  for (let i = 0; i < lines.length; i++) {
    const wasInBlockString = state.inBlockString;
    const braceBefore = braceDepth;
    const parenBefore = parenDepth;
    const scan = scanGraphqlLine(lines[i]!, state);

    braceDepth = Math.max(0, braceDepth + scan.openBrace - scan.closeBrace);
    parenDepth = Math.max(0, parenDepth + scan.openParen - scan.closeParen);

    if (wasInBlockString || braceBefore > 0 || parenBefore > 0) continue;
    const code = scan.code.trim();
    if (!code) continue;

    const tm = namedTypeRe.exec(code);
    if (tm && tm[1] && tm[2]) {
      const kind = tm[1];
      const expectsBrace = kind !== "union" && kind !== "scalar";
      symbols.push({
        kind,
        name: tm[2],
        startLine: i + 1,
        endLine: findGraphqlDefinitionEnd(lines, i, expectsBrace),
        depth: 0,
      });
      continue;
    }

    const dm = directiveRe.exec(code);
    if (dm && dm[1]) {
      symbols.push({
        kind: "directive",
        name: dm[1],
        startLine: i + 1,
        endLine: findGraphqlDefinitionEnd(lines, i, false),
        depth: 0,
      });
      continue;
    }

    if (schemaRe.test(code)) {
      symbols.push({
        kind: "schema",
        name: "schema",
        startLine: i + 1,
        endLine: findGraphqlDefinitionEnd(lines, i, true),
        depth: 0,
      });
      continue;
    }

    const fm = fragmentRe.exec(code);
    if (fm && fm[1]) {
      symbols.push({
        kind: "fragment",
        name: fm[1],
        startLine: i + 1,
        endLine: findGraphqlDefinitionEnd(lines, i, true),
        depth: 0,
      });
      continue;
    }

    const om = opRe.exec(code);
    if (om && om[1]) {
      symbols.push({
        kind: om[1],
        name: om[2] || om[1],
        startLine: i + 1,
        endLine: findGraphqlDefinitionEnd(lines, i, true),
        depth: 0,
      });
    }
  }

  return symbols;
}

interface HclScanState {
  inBlockComment: boolean;
  inString: boolean;
  interpBraceStack: number[];
  heredoc: { delim: string; indented: boolean } | null;
}

function scanHclLine(
  line: string,
  state: HclScanState,
): {
  code: string;
  openBrace: number;
  closeBrace: number;
  openBracket: number;
  closeBracket: number;
  openParen: number;
  closeParen: number;
  lastCodeChar: string;
} {
  let code = "";
  let openBrace = 0;
  let closeBrace = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openParen = 0;
  let closeParen = 0;
  let lastCodeChar = "";

  if (state.heredoc) {
    const check = state.heredoc.indented ? line.trim() : line.trimEnd();
    if (check === state.heredoc.delim) {
      state.heredoc = null;
      lastCodeChar = check[check.length - 1] ?? "";
    }
    return {
      code,
      openBrace,
      closeBrace,
      openBracket,
      closeBracket,
      openParen,
      closeParen,
      lastCodeChar,
    };
  }

  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (state.inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        state.inString = false;
        state.interpBraceStack.push(0);
        i += 2;
        continue;
      }
      if (ch === '"') {
        state.inString = false;
        lastCodeChar = '"';
      }
      i++;
      continue;
    }

    if (ch === "#" || (ch === "/" && next === "/")) {
      break;
    }

    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      code += " ";
      i += 2;
      continue;
    }

    if (ch === '"') {
      state.inString = true;
      if (state.interpBraceStack.length === 0) {
        let endQ = i + 1;
        while (endQ < line.length) {
          if (line[endQ] === "\\") {
            endQ += 2;
            continue;
          }
          if (line[endQ] === "$" && line[endQ + 1] === "{") break;
          if (line[endQ] === '"') break;
          endQ++;
        }
        if (endQ < line.length && line[endQ] === '"') {
          code += line.slice(i, endQ + 1);
          state.inString = false;
          lastCodeChar = '"';
          i = endQ + 1;
          continue;
        }
      }
      code += '""';
      i++;
      continue;
    }

    if (state.interpBraceStack.length > 0) {
      if (ch === "{") {
        state.interpBraceStack[state.interpBraceStack.length - 1]! += 1;
      } else if (ch === "}") {
        const top = state.interpBraceStack[state.interpBraceStack.length - 1]!;
        if (top === 0) {
          state.interpBraceStack.pop();
          state.inString = true;
        } else {
          state.interpBraceStack[state.interpBraceStack.length - 1] = top - 1;
        }
      }
      i++;
      continue;
    }

    if (ch === "<" && next === "<") {
      const hm = /^<<(-?)([A-Za-z_]\w*)/.exec(line.slice(i));
      if (hm && hm[2]) {
        state.heredoc = { delim: hm[2], indented: hm[1] === "-" };
        code += "<<";
        lastCodeChar = "<";
        i += hm[0].length;
        continue;
      }
    }

    code += ch;
    if (ch === "{") openBrace++;
    else if (ch === "}") closeBrace++;
    else if (ch === "[") openBracket++;
    else if (ch === "]") closeBracket++;
    else if (ch === "(") openParen++;
    else if (ch === ")") closeParen++;
    if (!/\s/.test(ch)) lastCodeChar = ch;
    i++;
  }

  return {
    code,
    openBrace,
    closeBrace,
    openBracket,
    closeBracket,
    openParen,
    closeParen,
    lastCodeChar,
  };
}

function findHclEndLine(
  lines: string[],
  startIdx: number,
  isAssignment: boolean,
): number {
  const state: HclScanState = {
    inBlockComment: false,
    inString: false,
    interpBraceStack: [],
    heredoc: null,
  };
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let seenOpenBrace = false;
  const maxScan = Math.min(lines.length, startIdx + 2000);

  for (let i = startIdx; i < maxScan; i++) {
    const scan = scanHclLine(lines[i]!, state);
    if (scan.openBrace > 0) seenOpenBrace = true;
    braceDepth = Math.max(0, braceDepth + scan.openBrace - scan.closeBrace);
    bracketDepth = Math.max(0, bracketDepth + scan.openBracket - scan.closeBracket);
    parenDepth = Math.max(0, parenDepth + scan.openParen - scan.closeParen);

    if (isAssignment) {
      if (i === startIdx && scan.lastCodeChar === "=") {
        continue;
      }
      if (
        braceDepth === 0 &&
        bracketDepth === 0 &&
        parenDepth === 0 &&
        !state.heredoc &&
        !state.inBlockComment &&
        !state.inString &&
        state.interpBraceStack.length === 0
      ) {
        return i + 1;
      }
    } else if (
      seenOpenBrace &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0 &&
      !state.heredoc
    ) {
      return i + 1;
    }
  }

  return Math.min(lines.length, maxScan);
}

function extractTerraformSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const state: HclScanState = {
    inBlockComment: false,
    inString: false,
    interpBraceStack: [],
    heredoc: null,
  };
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  const twoLabelRe =
    /^(resource|data)\s+(?:"([^"]+)"|([A-Za-z_][\w-]*))\s+(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*\{/;
  const oneLabelRe =
    /^(variable|output|module|provider|check)\s+(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*\{/;
  const zeroLabelRe = /^(locals|terraform|moved|import)\s*\{/;
  const assignRe = /^([A-Za-z_][\w-]*)\s*=(?!=)/;

  for (let i = 0; i < lines.length; i++) {
    const wasInComment = state.inBlockComment;
    const wasInHeredoc = state.heredoc !== null;
    const wasInString = state.inString || state.interpBraceStack.length > 0;
    const atTop = braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;

    const scan = scanHclLine(lines[i]!, state);
    braceDepth = Math.max(0, braceDepth + scan.openBrace - scan.closeBrace);
    bracketDepth = Math.max(0, bracketDepth + scan.openBracket - scan.closeBracket);
    parenDepth = Math.max(0, parenDepth + scan.openParen - scan.closeParen);

    if (!atTop || wasInComment || wasInHeredoc || wasInString) continue;
    const code = scan.code.trim();
    if (!code) continue;

    const m2 = twoLabelRe.exec(code);
    if (m2 && m2[1]) {
      const typeName = m2[2] || m2[3];
      const localName = m2[4] || m2[5];
      if (typeName && localName) {
        symbols.push({
          kind: m2[1],
          name: `${typeName}.${localName}`,
          startLine: i + 1,
          endLine: findHclEndLine(lines, i, false),
          depth: 0,
        });
        continue;
      }
    }

    const m1 = oneLabelRe.exec(code);
    if (m1 && m1[1]) {
      const label = m1[2] || m1[3];
      if (label) {
        symbols.push({
          kind: m1[1],
          name: label,
          startLine: i + 1,
          endLine: findHclEndLine(lines, i, false),
          depth: 0,
        });
        continue;
      }
    }

    const m0 = zeroLabelRe.exec(code);
    if (m0 && m0[1]) {
      symbols.push({
        kind: m0[1],
        name: m0[1],
        startLine: i + 1,
        endLine: findHclEndLine(lines, i, false),
        depth: 0,
      });
      continue;
    }

    const ma = assignRe.exec(code);
    if (ma && ma[1]) {
      symbols.push({
        kind: "key",
        name: ma[1],
        startLine: i + 1,
        endLine: findHclEndLine(lines, i, true),
        depth: 0,
      });
    }
  }

  return symbols;
}

function extractDockerfileSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const stageEntries: SymbolEntry[] = [];
  let escapeChar = "\\";

  // Check optional Dockerfile parser directive `# escape=\` or `# escape=\`` at top of file
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("#")) break;
    const escMatch = /^#\s*escape\s*=\s*([\\`])\s*$/i.exec(trimmed);
    if (escMatch && escMatch[1]) {
      escapeChar = escMatch[1];
      break;
    }
  }

  let i = 0;
  let activeStage: SymbolEntry | null = null;

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const startIdx = i;
    const parts: string[] = [];
    let endIdx = i;
    let heredocDelim: { delim: string; indented: boolean } | null = null;

    while (endIdx < lines.length) {
      const cur = lines[endIdx]!;
      const curTrim = cur.trim();
      if (endIdx > startIdx && curTrim.startsWith("#")) {
        endIdx++;
        continue;
      }
      const rtrimmed = cur.trimEnd();
      const hasCont =
        rtrimmed.length > 0 &&
        rtrimmed[rtrimmed.length - 1] === escapeChar &&
        (rtrimmed.length < 2 || rtrimmed[rtrimmed.length - 2] !== escapeChar);
      const cleanPart = hasCont ? rtrimmed.slice(0, -1).trim() : curTrim;
      if (cleanPart) parts.push(cleanPart);

      if (!heredocDelim) {
        const hm = /<<(-?)(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(cleanPart);
        if (hm) {
          const delim = hm[2] || hm[3] || hm[4];
          if (delim) {
            heredocDelim = { delim, indented: hm[1] === "-" };
          }
        }
      }

      if (hasCont) {
        endIdx++;
        continue;
      }
      break;
    }

    if (heredocDelim) {
      endIdx++;
      while (endIdx < lines.length) {
        const hdLine = heredocDelim.indented
          ? lines[endIdx]!.trim()
          : lines[endIdx]!.trimEnd();
        if (hdLine === heredocDelim.delim) break;
        endIdx++;
      }
    }

    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    const instrMatch = /^([A-Za-z]+)\s+(.*)$/.exec(joined);
    if (instrMatch && instrMatch[1]) {
      const kw = instrMatch[1].toUpperCase();
      let rest = instrMatch[2]!.trim();

      if (kw === "FROM") {
        while (rest.startsWith("--")) {
          const sp = rest.search(/\s/);
          if (sp < 0) break;
          rest = rest.slice(sp).trimStart();
        }
        const fromMatch = /^(\S+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i.exec(rest);
        const image = fromMatch?.[1] ?? rest;
        const alias = fromMatch?.[2];
        const stageName = alias ? `${image} AS ${alias}` : image;
        const stageSym: SymbolEntry = {
          kind: "stage",
          name: sliceSafeChars(stageName, 64),
          startLine: startIdx + 1,
          endLine: Math.min(lines.length, endIdx + 1),
          depth: 0,
        };
        symbols.push(stageSym);
        stageEntries.push(stageSym);
        activeStage = stageSym;
      } else if (kw === "ARG") {
        const argNames = rest
          .split(/\s+/)
          .map((tok) => tok.split("=")[0]?.trim() ?? "")
          .filter((n) => /^[A-Za-z_]\w*$/.test(n));
        const label = argNames.length > 0 ? argNames.join(", ") : sliceSafeChars(rest, 48);
        if (label) {
          symbols.push({
            kind: "arg",
            name: label,
            startLine: startIdx + 1,
            endLine: Math.min(lines.length, endIdx + 1),
            depth: activeStage ? 1 : 0,
          });
        }
      } else if (kw === "ENTRYPOINT" || kw === "CMD") {
        symbols.push({
          kind: kw.toLowerCase(),
          name: sliceSafeChars(rest, 60),
          startLine: startIdx + 1,
          endLine: Math.min(lines.length, endIdx + 1),
          depth: activeStage ? 1 : 0,
        });
      }
    }

    i = Math.max(startIdx + 1, endIdx + 1);
  }

  for (let idx = 0; idx < stageEntries.length; idx++) {
    const stage = stageEntries[idx]!;
    let bound =
      idx + 1 < stageEntries.length
        ? stageEntries[idx + 1]!.startLine - 1
        : lines.length;
    while (
      bound > stage.startLine &&
      (!(lines[bound - 1] ?? "").trim() || (lines[bound - 1] ?? "").trim().startsWith("#"))
    ) {
      bound--;
    }
    stage.endLine = Math.max(stage.startLine, bound);
  }

  return symbols;
}

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_RAW_SKIP_TAGS = new Set([
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes",
]);

const HTML_SEMANTIC_TAGS = new Set([
  "head",
  "body",
  "header",
  "nav",
  "main",
  "aside",
  "section",
  "article",
  "footer",
  "form",
  "dialog",
  "template",
]);

const HTML_CONTAINER_TAGS = new Set([
  "div",
  "ul",
  "ol",
  "table",
  "fieldset",
  "details",
]);

const COMPONENT_LANDMARK_RE =
  /^(?:[A-Z][A-Za-z0-9]*\.)?(?:[A-Z][A-Za-z0-9]*)?(?:Modal|Drawer|Dialog|Panel|Tabs?|View|Page|Form)$/;

const MAX_HTML_DEPTH = 2;
const MAX_TAG_HEADER_SCAN = 8192;

function leadingWhitespaceCols(line: string, tabWidth = 4): number {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += tabWidth;
    else break;
  }
  return cols;
}

function stripLeadingCols(line: string, colsToStrip: number, tabWidth = 4): string {
  if (colsToStrip <= 0) return line;
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < colsToStrip) {
    const ch = line[idx]!;
    if (ch === " ") {
      cols += 1;
      idx++;
    } else if (ch === "\t") {
      cols += tabWidth;
      idx++;
    } else {
      break;
    }
  }
  if (cols > colsToStrip) {
    return " ".repeat(cols - colsToStrip) + line.slice(idx);
  }
  return line.slice(idx);
}

/**
 * Dedents an inline `<script>` / `<style>` body by visual column width so mixed
 * tabs/spaces, opening-line code (`skipFirstLineForIndent`), and column-0
 * multiline template-literal lines never wipe out top-level symbols.
 */
function dedentBlockLines(
  lines: string[],
  skipFirstLineForIndent = false,
): string[] {
  const startIdx = skipFirstLineForIndent ? 1 : 0;
  let firstNonEmptyIndent = -1;
  let minPosCols = Infinity;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cols = leadingWhitespaceCols(line);
    if (firstNonEmptyIndent === -1) firstNonEmptyIndent = cols;
    if (cols > 0 && cols < minPosCols) minPosCols = cols;
  }

  if (firstNonEmptyIndent <= 0 || !Number.isFinite(minPosCols) || minPosCols <= 0) {
    return lines;
  }

  return lines.map((line, idx) => {
    if (idx < startIdx || !line.trim()) return line;
    return stripLeadingCols(line, minPosCols);
  });
}

function findMatchingBrace(
  text: string,
  start: number,
  maxLookahead = 2000,
): number {
  const limit = Math.min(text.length, start + maxLookahead);
  let depth = 0;
  let quote: string | null = null;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingMustache(
  text: string,
  start: number,
  maxLookahead = 2000,
): number {
  const limit = Math.min(text.length, start + maxLookahead);
  let quote: string | null = null;
  let escape = false;
  for (let i = start + 2; i + 1 < limit; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "}" && text[i + 1] === "}") {
      return i;
    }
  }
  return -1;
}

function parseHtmlAttrs(attrText: string): {
  attrs: Map<string, string>;
  vueSlot?: string;
} {
  const attrs = new Map<string, string>();
  let vueSlot: string | undefined;
  let i = 0;
  const len = attrText.length;

  while (i < len) {
    while (i < len && /[\s/]/.test(attrText[i]!)) i++;
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>"'`]/.test(attrText[i]!)) i++;
    const rawName = attrText.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }

    const lowerName = rawName.toLowerCase();
    if (!vueSlot && rawName.startsWith("#") && rawName.length > 1) {
      vueSlot = rawName.slice(1);
    } else if (!vueSlot && lowerName.startsWith("v-slot:") && rawName.length > 7) {
      vueSlot = rawName.slice(7);
    }

    while (i < len && /\s/.test(attrText[i]!)) i++;
    let value = "";
    if (i < len && attrText[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrText[i]!)) i++;
      if (i < len) {
        const ch = attrText[i]!;
        if (ch === '"' || ch === "'") {
          const quote = ch;
          i++;
          const valStart = i;
          while (i < len && attrText[i] !== quote) i++;
          value = attrText.slice(valStart, i);
          if (i < len) i++;
        } else if (ch === "{") {
          const endBrace = findMatchingBrace(attrText, i);
          if (endBrace >= 0) {
            value = attrText.slice(i, endBrace + 1);
            i = endBrace + 1;
          } else {
            const valStart = i;
            while (i < len && !/[\s/>]/.test(attrText[i]!)) i++;
            value = attrText.slice(valStart, i);
          }
        } else {
          const valStart = i;
          while (i < len && !/[\s/>]/.test(attrText[i]!)) i++;
          value = attrText.slice(valStart, i);
        }
      }
    }

    if (!attrs.has(lowerName)) {
      attrs.set(lowerName, value);
    }
  }

  return { attrs, vueSlot };
}

function normalizeInlineAttr(value: string | undefined, maxChars: number): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? sliceSafeChars(compact, maxChars) : "";
}

function formatHtmlTagLabel(
  displayTag: string,
  lowerTag: string,
  rawAttrs: string,
  parsed: { attrs: Map<string, string>; vueSlot?: string },
): string {
  if (lowerTag === "script" || lowerTag === "style") {
    const compact = normalizeInlineAttr(rawAttrs, 40);
    return compact ? `<${lowerTag} ${compact}>` : `<${lowerTag}>`;
  }

  const idVal = normalizeInlineAttr(parsed.attrs.get("id"), 36);
  if (idVal) {
    return `<${displayTag} #${idVal}>`;
  }
  const testIdVal = normalizeInlineAttr(parsed.attrs.get("data-testid"), 36);
  if (testIdVal) {
    return `<${displayTag} data-testid="${testIdVal}">`;
  }
  const roleVal = normalizeInlineAttr(parsed.attrs.get("role"), 36);
  if (roleVal) {
    return `<${displayTag} role="${roleVal}">`;
  }
  const slotVal = normalizeInlineAttr(parsed.vueSlot, 36);
  if (lowerTag === "template" && slotVal) {
    return `<template #${slotVal}>`;
  }
  return `<${displayTag}>`;
}

function isJsScriptType(typeAttr: string | undefined): boolean {
  if (typeAttr === undefined) return true;
  const mime = typeAttr.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    !mime ||
    mime === "module" ||
    mime === "text/javascript" ||
    mime === "application/javascript" ||
    mime === "text/ecmascript" ||
    mime === "application/ecmascript" ||
    mime === "text/typescript" ||
    mime === "ts" ||
    mime === "tsx" ||
    mime === "jsx"
  );
}

function isCommentDecorChar(ch: string): boolean {
  return (
    ch === "=" ||
    ch === "-" ||
    ch === "*" ||
    ch === "#" ||
    ch === "~" ||
    ch === ":" ||
    ch === " " ||
    ch === "\t" ||
    ch === "\r" ||
    ch === "\n"
  );
}

function extractCommentLandmark(inner: string): string | null {
  let start = 0;
  let end = inner.length;
  while (start < end && isCommentDecorChar(inner[start]!)) start++;
  while (end > start && isCommentDecorChar(inner[end - 1]!)) end--;
  const cleaned = inner.slice(start, end);
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/[<>]/.test(cleaned)) return null;
  if (/^(?:eslint|prettier|istanbul|c8|v8|@ts-)/i.test(cleaned)) return null;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return null;
  return cleaned;
}

type TemplateMode = "html" | "vue" | "svelte";

function extractTemplateSymbols(
  rawLines: string[],
  mode: TemplateMode = "html",
): SymbolEntry[] {
  if (rawLines.length === 0) return [];
  const lines =
    rawLines[0]!.startsWith("\uFEFF")
      ? [rawLines[0]!.slice(1), ...rawLines.slice(1)]
      : rawLines;

  const text = lines.join("\n");
  const lineStarts: number[] = new Array<number>(lines.length);
  let acc = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    lineStarts[idx] = acc;
    acc += lines[idx]!.length + 1;
  }

  const offsetToLineIdx = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  interface OpenFrame {
    lowerTag: string;
    startLine: number;
    emitted: boolean;
    symbol?: SymbolEntry;
  }

  const symbols: SymbolEntry[] = [];
  const stack: OpenFrame[] = [];
  const stackTagCounts = new Map<string, number>();
  const pushFrame = (frame: OpenFrame) => {
    stack.push(frame);
    stackTagCounts.set(frame.lowerTag, (stackTagCounts.get(frame.lowerTag) ?? 0) + 1);
  };
  const popFrame = (): OpenFrame => {
    const frame = stack.pop()!;
    const prev = stackTagCounts.get(frame.lowerTag) ?? 0;
    if (prev <= 1) stackTagCounts.delete(frame.lowerTag);
    else stackTagCounts.set(frame.lowerTag, prev - 1);
    return frame;
  };

  let emittedCount = 0;
  let noCloseSingle = false;
  let noCloseDouble = false;
  let noCloseScript = false;
  let noCloseStyle = false;
  let noCloseBodyBrace = false;
  let noCloseMustache = false;
  const noCloseRawSkip = new Set<string>();
  let nextRightBrace = text.indexOf("}");
  let nextCloseMustache = mode === "vue" ? text.indexOf("}}") : -1;

  let i = 0;
  const len = text.length;

  while (i < len) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;

    // Skip template expressions in Svelte (`{...}`) and Vue (`{{...}}`) body text
    // before `<` so `{@html '</div>'}`, `{#if x<script && y>0}`, and `{{ a<section && x => y }}`
    // cannot corrupt the tag stack or trigger unclosed raw-text blocks.
    if (mode === "svelte" && !noCloseBodyBrace) {
      const bracePos = text.indexOf("{", i);
      if (bracePos >= 0 && bracePos < lt) {
        if (nextRightBrace !== -1 && nextRightBrace < bracePos) {
          nextRightBrace = text.indexOf("}", bracePos);
        }
        if (nextRightBrace === -1) {
          noCloseBodyBrace = true;
        } else if (nextRightBrace < bracePos + 2000) {
          const endBrace = findMatchingBrace(text, bracePos);
          if (endBrace >= 0) {
            i = endBrace + 1;
            continue;
          }
          i = bracePos + 1;
          continue;
        } else if (nextRightBrace < lt) {
          i = nextRightBrace + 1;
          continue;
        }
      }
    } else if (mode === "vue" && !noCloseMustache) {
      const mustachePos = text.indexOf("{{", i);
      if (mustachePos >= 0 && mustachePos < lt) {
        if (nextCloseMustache !== -1 && nextCloseMustache < mustachePos + 2) {
          nextCloseMustache = text.indexOf("}}", mustachePos + 2);
        }
        if (nextCloseMustache === -1) {
          noCloseMustache = true;
        } else if (nextCloseMustache < mustachePos + 2000) {
          const endMustache = findClosingMustache(text, mustachePos);
          if (endMustache >= 0) {
            i = endMustache + 2;
            continue;
          }
          i = mustachePos + 2;
          continue;
        } else if (nextCloseMustache < lt) {
          i = nextCloseMustache + 2;
          continue;
        }
      }
    }

    i = lt;

    // 1. HTML comments: <!-- ... --> (including HTML5 empty <!--> / <!---> and --!>)
    if (text.startsWith("<!--", i)) {
      if (text.startsWith("<!-->", i)) {
        i += 5;
        continue;
      }
      if (text.startsWith("<!--->", i)) {
        i += 6;
        continue;
      }
      const startLineIdx = offsetToLineIdx(i);
      const stdClose = text.indexOf("-->", i + 4);
      const bangClose = text.indexOf("--!>", i + 4);
      let closePos = -1;
      let closeLen = 3;
      if (stdClose >= 0 && (bangClose < 0 || stdClose <= bangClose)) {
        closePos = stdClose;
        closeLen = 3;
      } else if (bangClose >= 0) {
        closePos = bangClose;
        closeLen = 4;
      }
      if (closePos < 0) {
        break;
      }
      const endLineIdx = offsetToLineIdx(closePos + closeLen - 1);
      if (startLineIdx === endLineIdx && closeLen === 3) {
        const lineTrim = lines[startLineIdx]!.trim();
        if (
          lineTrim.startsWith("<!--") &&
          lineTrim.endsWith("-->") &&
          lineTrim.indexOf("-->", 4) === lineTrim.length - 3
        ) {
          const landmark = extractCommentLandmark(text.slice(i + 4, closePos));
          if (landmark) {
            const ln = startLineIdx + 1;
            symbols.push({
              kind: "section",
              name: landmark,
              startLine: ln,
              endLine: ln,
              depth: Math.min(MAX_HTML_DEPTH, emittedCount),
            });
          }
        }
      }
      i = closePos + closeLen;
      continue;
    }

    // 2. CDATA: <![CDATA[ ... ]]>
    if (text.startsWith("<![CDATA[", i)) {
      const closePos = text.indexOf("]]>", i + 9);
      i = closePos < 0 ? len : closePos + 3;
      continue;
    }

    // 3. Processing instruction <?...?> or Doctype/declaration <!...>
    const nextCh = text[i + 1];
    if (nextCh === "?") {
      const closePi = text.indexOf("?>", i + 2);
      if (closePi >= 0) {
        i = closePi + 2;
      } else {
        const closeGt = text.indexOf(">", i + 2);
        i = closeGt >= 0 ? closeGt + 1 : len;
      }
      continue;
    }
    if (nextCh === "!") {
      let quote: string | null = null;
      let j = i + 2;
      while (j < len) {
        const c = text[j]!;
        if (quote) {
          if (c === quote || c === "\n") quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ">") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    // 4. Closing tag: </tagName>
    if (nextCh === "/") {
      const nameStart = i + 2;
      if (nameStart >= len || !/[A-Za-z]/.test(text[nameStart]!)) {
        i += 2;
        continue;
      }
      let j = nameStart + 1;
      while (j < len && /[A-Za-z0-9:._-]/.test(text[j]!)) j++;
      const closeLowerTag = text.slice(nameStart, j).toLowerCase();
      while (j < len && text[j] !== ">") j++;
      if (j < len && text[j] === ">") j++;

      const closeLine = offsetToLineIdx(Math.max(i, j - 1)) + 1;

      if ((stackTagCounts.get(closeLowerTag) ?? 0) > 0) {
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.lowerTag === closeLowerTag) {
            matchIdx = s;
            break;
          }
        }

        if (matchIdx >= 0) {
          for (let s = stack.length - 1; s > matchIdx; s--) {
            const unclosed = popFrame();
            if (unclosed.emitted) {
              emittedCount = Math.max(0, emittedCount - 1);
              if (unclosed.symbol) {
                unclosed.symbol.endLine = Math.max(
                  unclosed.symbol.endLine,
                  closeLine > unclosed.startLine ? closeLine - 1 : unclosed.startLine,
                );
              }
            }
          }
          const matched = popFrame();
          if (matched.emitted) {
            emittedCount = Math.max(0, emittedCount - 1);
            if (matched.symbol) {
              matched.symbol.endLine = Math.max(matched.symbol.endLine, closeLine);
            }
          }
        }
      }

      i = j;
      continue;
    }

    // 5. Opening tag: <tagName ...> or <tagName ... />
    if (!nextCh || !/[A-Za-z]/.test(nextCh)) {
      i++;
      continue;
    }

    const tagStart = i;
    let nameEnd = i + 1;
    while (nameEnd < len && /[A-Za-z0-9:._-]/.test(text[nameEnd]!)) nameEnd++;
    const afterNameCh = text[nameEnd];
    if (afterNameCh !== undefined && !/[\s/>]/.test(afterNameCh)) {
      i = nameEnd;
      continue;
    }

    const rawTag = text.slice(i + 1, nameEnd);
    const lowerTag = rawTag.toLowerCase();

    // Scan tag header to unquoted closing `>` with bounded linear brace tracking
    const headerLimit = Math.min(len, nameEnd + MAX_TAG_HEADER_SCAN);
    let j = nameEnd;
    let quote: string | null = null;
    let braceDepth = 0;
    let braceQuote: string | null = null;
    let braceEscape = false;
    let lastUnquotedNonWs = "";
    let foundGt = false;
    while (j < headerLimit) {
      const c = text[j]!;
      if (braceDepth > 0) {
        if (braceEscape) {
          braceEscape = false;
        } else if (braceQuote) {
          if (c === "\\") braceEscape = true;
          else if (c === braceQuote) braceQuote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          braceQuote = c;
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
          if (braceDepth === 0) lastUnquotedNonWs = "}";
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if ((c === '"' || c === "'") && lastUnquotedNonWs === "=") {
        if ((c === '"' && !noCloseDouble) || (c === "'" && !noCloseSingle)) {
          quote = c;
        }
        lastUnquotedNonWs = c;
        j++;
        continue;
      }
      if (c === "{") {
        if (nextRightBrace !== -1 && nextRightBrace < j) {
          nextRightBrace = text.indexOf("}", j);
        }
        if (nextRightBrace === -1 || nextRightBrace >= headerLimit) {
          foundGt = false;
          break;
        }
        braceDepth = 1;
        braceQuote = null;
        braceEscape = false;
        j++;
        continue;
      }
      if (c === "<") {
        foundGt = false;
        break;
      }
      // Reject unquoted logical/arrow operators outside quotes & braces (e.g. `a<form && b>0`)
      if (
        (c === "&" && text[j + 1] === "&") ||
        (c === "|" && text[j + 1] === "|") ||
        (c === "=" && text[j + 1] === ">")
      ) {
        foundGt = false;
        break;
      }
      if (c === ">") {
        foundGt = true;
        break;
      }
      if (!/\s/.test(c)) {
        lastUnquotedNonWs = c;
      }
      j++;
    }

    if (!foundGt) {
      if (j === len) {
        if (quote === '"') noCloseDouble = true;
        else if (quote === "'") noCloseSingle = true;
      }
      i = tagStart + 1;
      continue;
    }

    const gtPos = j;
    const selfClosing = lastUnquotedNonWs === "/";
    const rawAttrSlice = text.slice(
      nameEnd,
      selfClosing ? text.lastIndexOf("/", gtPos) : gtPos,
    );
    const startLineIdx = offsetToLineIdx(tagStart);
    const openEndLineIdx = offsetToLineIdx(gtPos);
    const startLine = startLineIdx + 1;
    const openEndLine = openEndLineIdx + 1;

    // Raw-text / RCDATA elements whose content must NOT be parsed as markup (<textarea>, <title>, <xmp>, etc.)
    if (HTML_RAW_SKIP_TAGS.has(lowerTag)) {
      if (selfClosing || noCloseRawSkip.has(lowerTag)) {
        i = gtPos + 1;
        continue;
      }
      const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
      closeRe.lastIndex = gtPos + 1;
      const closeMatch = closeRe.exec(text);
      if (closeMatch) {
        i = closeMatch.index + closeMatch[0].length;
      } else {
        noCloseRawSkip.add(lowerTag);
        i = gtPos + 1;
      }
      continue;
    }

    // Raw-text blocks with recursive symbol extraction: <script> and <style>
    if (lowerTag === "script" || lowerTag === "style") {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const tagDepth = Math.min(MAX_HTML_DEPTH, emittedCount);
      const label = formatHtmlTagLabel(lowerTag, lowerTag, rawAttrSlice, parsed);

      if (selfClosing) {
        symbols.push({
          kind: lowerTag,
          name: label,
          startLine,
          endLine: openEndLine,
          depth: tagDepth,
        });
        i = gtPos + 1;
        continue;
      }

      const noCloseLatch = lowerTag === "script" ? noCloseScript : noCloseStyle;
      let closeMatch: RegExpExecArray | null = null;
      if (!noCloseLatch) {
        const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
        closeRe.lastIndex = gtPos + 1;
        closeMatch = closeRe.exec(text);
        if (!closeMatch) {
          if (lowerTag === "script") noCloseScript = true;
          else noCloseStyle = true;
        }
      }

      let closeStart: number;
      let endLine: number;
      let nextPos: number;

      if (closeMatch) {
        closeStart = closeMatch.index;
        const closeEndPos = closeMatch.index + closeMatch[0].length;
        endLine = Math.max(startLine, offsetToLineIdx(closeEndPos - 1) + 1);
        nextPos = closeEndPos;
      } else if (lowerTag === "script" && parsed.attrs.has("src")) {
        // Resilient recovery for unclosed external <script src="...">
        closeStart = gtPos + 1;
        endLine = openEndLine;
        nextPos = gtPos + 1;
      } else {
        closeStart = len;
        endLine = Math.max(startLine, lines.length);
        nextPos = len;
      }

      symbols.push({
        kind: lowerTag,
        name: label,
        startLine,
        endLine,
        depth: tagDepth,
      });

      const shouldRecurse =
        closeStart > gtPos + 1 &&
        (lowerTag === "style" ||
          (!parsed.attrs.has("src") && isJsScriptType(parsed.attrs.get("type"))));

      if (shouldRecurse) {
        const closeLineIdx = offsetToLineIdx(
          closeStart < len ? closeStart : Math.max(0, len - 1),
        );
        const innerLines: string[] = [];
        let innerBaseLineIdx: number;
        let hasFirstRest = false;

        if (openEndLineIdx === closeLineIdx) {
          innerBaseLineIdx = openEndLineIdx;
          const singleInner = text.slice(gtPos + 1, closeStart);
          if (singleInner.trim()) {
            innerLines.push(singleInner);
          }
        } else {
          const openLineEnd =
            openEndLineIdx + 1 < lineStarts.length
              ? lineStarts[openEndLineIdx + 1]! - 1
              : len;
          const firstRest = text.slice(gtPos + 1, openLineEnd);
          if (firstRest.trim()) {
            innerBaseLineIdx = openEndLineIdx;
            innerLines.push(firstRest.trimStart());
            hasFirstRest = true;
          } else {
            innerBaseLineIdx = openEndLineIdx + 1;
          }
          for (let li = openEndLineIdx + 1; li < closeLineIdx; li++) {
            innerLines.push(lines[li]!);
          }
          if (closeStart < len) {
            const lastPrefix = text.slice(lineStarts[closeLineIdx]!, closeStart);
            if (lastPrefix.trim()) {
              innerLines.push(lastPrefix);
            }
          } else if (closeLineIdx >= openEndLineIdx + 1) {
            innerLines.push(lines[closeLineIdx]!);
          }
        }

        if (innerLines.some((l) => l.trim().length > 0)) {
          const dedented = dedentBlockLines(innerLines, hasFirstRest);
          const innerSyms =
            lowerTag === "script"
              ? extractTsJsSymbols(dedented)
              : extractCssSymbols(dedented, true);
          for (const s of innerSyms) {
            const childStart = s.startLine + innerBaseLineIdx;
            const childEnd = Math.max(childStart, s.endLine + innerBaseLineIdx);
            symbols.push({
              kind: s.kind,
              name: s.name,
              startLine: childStart,
              endLine: childEnd,
              depth: Math.min(MAX_HTML_DEPTH, tagDepth + 1 + s.depth),
            });
          }
        }
      }

      i = nextPos;
      continue;
    }

    const isVoid = HTML_VOID_ELEMENTS.has(lowerTag);
    const isComponent = COMPONENT_LANDMARK_RE.test(rawTag);
    const isSemantic = HTML_SEMANTIC_TAGS.has(lowerTag);
    const isContainer = HTML_CONTAINER_TAGS.has(lowerTag);

    let shouldEmit = false;
    let emittedSymbol: SymbolEntry | undefined;

    if (isComponent || isSemantic || isContainer) {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const hasIdentityAttr =
        Boolean(parsed.attrs.get("id")?.trim()) ||
        Boolean(parsed.attrs.get("data-testid")?.trim()) ||
        Boolean(parsed.attrs.get("role")?.trim());
      // Skip nested Vue control-flow `<template v-if>` / `<template v-for>` wrappers
      // while keeping root `<template>`, named slots (`#header`), and identified templates.
      const keepTemplate =
        lowerTag !== "template" ||
        emittedCount === 0 ||
        Boolean(parsed.vueSlot) ||
        hasIdentityAttr;

      if (
        keepTemplate &&
        (isComponent || isSemantic || (isContainer && hasIdentityAttr))
      ) {
        shouldEmit = true;
        const displayTag = isComponent ? rawTag : lowerTag;
        const kind =
          lowerTag === "template"
            ? "template"
            : isComponent
              ? "component"
              : "block";
        emittedSymbol = {
          kind,
          name: formatHtmlTagLabel(displayTag, lowerTag, rawAttrSlice, parsed),
          startLine,
          endLine: openEndLine,
          depth: Math.min(MAX_HTML_DEPTH, emittedCount),
        };
        symbols.push(emittedSymbol);
      }
    }

    if (!selfClosing && !isVoid) {
      pushFrame({
        lowerTag,
        startLine,
        emitted: shouldEmit,
        symbol: emittedSymbol,
      });
      if (shouldEmit) emittedCount++;
    }

    i = gtPos + 1;
  }

  // Unwind any unclosed tags cleanly at EOF
  const eofLine = lines.length;
  while (stack.length > 0) {
    const frame = popFrame();
    if (frame.emitted && frame.symbol) {
      frame.symbol.endLine = Math.max(frame.symbol.endLine, eofLine);
    }
  }

  return symbols;
}

function extractHtmlSymbols(lines: string[]): SymbolEntry[] {
  return extractTemplateSymbols(lines, "html");
}

function extractSfcSymbols(lines: string[], mode: "vue" | "svelte"): SymbolEntry[] {
  const symbols = extractTemplateSymbols(lines, mode);
  return symbols.length > 0 ? symbols : extractTsJsSymbols(lines);
}

function extractSymbolsFromLines(filePath: string, lines: string[]): SymbolEntry[] {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  if (
    base === "dockerfile" ||
    base.startsWith("dockerfile.") ||
    base === "containerfile" ||
    base.startsWith("containerfile.") ||
    ext === ".dockerfile" ||
    ext === ".containerfile"
  ) {
    return extractDockerfileSymbols(lines);
  }

  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".html":
    case ".htm":
      return extractHtmlSymbols(lines);
    case ".vue":
      return extractSfcSymbols(lines, "vue");
    case ".svelte":
      return extractSfcSymbols(lines, "svelte");
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return extractCssSymbols(lines);
    case ".py":
    case ".pyi":
      return extractPythonSymbols(lines);
    case ".gd":
      return extractGdScriptSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    case ".sql":
      return extractSqlSymbols(lines);
    case ".proto":
      return extractProtoSymbols(lines);
    case ".graphql":
    case ".gql":
    case ".graphqls":
      return extractGraphqlSymbols(lines);
    case ".tf":
    case ".tfvars":
    case ".hcl":
      return extractTerraformSymbols(lines);
    default:
      return extractTsJsSymbols(lines);
  }
}

export function extractSymbols(filePath: string, content: string): SymbolEntry[] {
  const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = normalized.replace(/\r\n/g, "\n").split("\n");
  return extractSymbolsFromLines(filePath, lines);
}

const MAX_OUTLINES = 40;
const MAX_SLICE_FILES = 30;
const SLICE_TRUNCATION_TIP =
  "\n[tip: MCP responses are hard-capped <=8.8KB inline; for >150 lines across files, use parallel read_file(StartLine, EndLine) (46KB/call, 0 remote check)]";
const OUTLINE_BATCH_TIP =
  "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";

function formatSymbolLine(s: SymbolEntry): string {
  const indent = "  ".repeat(s.depth);
  const span =
    s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
  return `${indent}${span} [${s.kind}] ${s.name}`;
}

function formatNestedOmissionFooter(omittedNested: number, compact = false): string {
  return compact
    ? `\n... (+${omittedNested} nested)`
    : `\n... (+${omittedNested} nested symbols omitted)`;
}

function pickTopLevelOmissionFooter(
  omittedTop: number,
  minStart: number,
  maxEnd: number,
  hasOmittedNested: boolean,
  availChars: number,
  availBytes: number,
): string | null {
  const candidates = [
    hasOmittedNested
      ? `\n... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted, plus nested; use batch_search or read_file)`
      : `\n... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted; use batch_search or read_file)`,
    `\n... (+${omittedTop} more in L${minStart}-L${maxEnd} omitted)`,
    `\n... (+${omittedTop} L${minStart}-L${maxEnd})`,
  ];
  for (const cand of candidates) {
    if (cand.length <= availChars && Buffer.byteLength(cand, "utf8") <= availBytes) {
      return cand;
    }
  }
  return null;
}

function packOutlineToBudget(
  header: string,
  symbols: SymbolEntry[],
  charBudget: number,
  byteBudget: number,
): string {
  const items = symbols.map((sym) => {
    const line = formatSymbolLine(sym);
    return {
      line,
      chars: line.length + 1, // +1 for leading '\n'
      bytes: Buffer.byteLength(line, "utf8") + 1,
    };
  });

  const headerChars = header.length;
  const headerBytes = Buffer.byteLength(header, "utf8");
  let fullChars = headerChars;
  let fullBytes = headerBytes;
  for (const item of items) {
    fullChars += item.chars;
    fullBytes += item.bytes;
  }

  if (fullChars <= charBudget && fullBytes <= byteBudget) {
    return `${header}\n${items.map((it) => it.line).join("\n")}`;
  }

  const byDepth = new Map<number, number[]>();
  for (let idx = 0; idx < symbols.length; idx++) {
    const d = symbols[idx]!.depth;
    let list = byDepth.get(d);
    if (!list) {
      list = [];
      byDepth.set(d, list);
    }
    list.push(idx);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const topDepth = depths[0] ?? 0;
  const topIndices = byDepth.get(topDepth) ?? [];
  const nestedTotalCount = symbols.length - topIndices.length;

  let topChars = headerChars;
  let topBytes = headerBytes;
  for (const idx of topIndices) {
    topChars += items[idx]!.chars;
    topBytes += items[idx]!.bytes;
  }

  // Branch A: All top-level (minimum-depth) symbols fit alongside a nested-omission footer -> backfill deeper levels
  if (nestedTotalCount > 0) {
    const fullNestedFooterLen = formatNestedOmissionFooter(nestedTotalCount, false).length;
    const compactNestedFooterLen = formatNestedOmissionFooter(nestedTotalCount, true).length;
    const fitsFullNested =
      topChars + fullNestedFooterLen <= charBudget &&
      topBytes + fullNestedFooterLen <= byteBudget;
    const fitsCompactNested =
      !fitsFullNested &&
      topChars + compactNestedFooterLen <= charBudget &&
      topBytes + compactNestedFooterLen <= byteBudget;

    if (fitsFullNested || fitsCompactNested) {
      const useCompact = !fitsFullNested;
      const selected = new Set<number>(topIndices);
      let usedChars = topChars;
      let usedBytes = topBytes;
      let omittedNested = nestedTotalCount;
      let stopped = false;

      for (const d of depths) {
        if (d === topDepth) continue;
        if (stopped) break;
        const indices = byDepth.get(d)!;
        for (const idx of indices) {
          const item = items[idx]!;
          const nextOmitted = omittedNested - 1;
          const nextFooterLen =
            nextOmitted > 0
              ? formatNestedOmissionFooter(nextOmitted, useCompact).length
              : 0;
          if (
            usedChars + item.chars + nextFooterLen <= charBudget &&
            usedBytes + item.bytes + nextFooterLen <= byteBudget
          ) {
            selected.add(idx);
            usedChars += item.chars;
            usedBytes += item.bytes;
            omittedNested = nextOmitted;
          } else {
            stopped = true;
            break;
          }
        }
      }

      const ordered = [...selected].sort((a, b) => a - b);
      const footer =
        omittedNested > 0 ? formatNestedOmissionFooter(omittedNested, useCompact) : "";
      if (ordered.length === 0) {
        return `${header}${footer}`;
      }
      return `${header}\n${ordered.map((idx) => items[idx]!.line).join("\n")}${footer}`;
    }
  }

  // Branch B: Even top-level symbols overflow the file's budget -> fit prefix + exact L<min>-L<max> footer
  const m = topIndices.length;
  const suffixMinStart = new Array<number>(m);
  const suffixMaxEnd = new Array<number>(m);
  for (let k = m - 1; k >= 0; k--) {
    const sym = symbols[topIndices[k]!]!;
    if (k === m - 1) {
      suffixMinStart[k] = sym.startLine;
      suffixMaxEnd[k] = sym.endLine;
    } else {
      suffixMinStart[k] = Math.min(sym.startLine, suffixMinStart[k + 1]!);
      suffixMaxEnd[k] = Math.max(sym.endLine, suffixMaxEnd[k + 1]!);
    }
  }

  const tryPackPrefixWithTier = (
    tier: "full" | "compact",
  ): { pickedCount: number; footer: string } => {
    let usedChars = headerChars;
    let usedBytes = headerBytes;
    let pickedCount = 0;
    let chosenFooter = "";

    for (let k = 0; k < m; k++) {
      const nextOmitted = m - (k + 1);
      const item = items[topIndices[k]!]!;
      if (nextOmitted === 0) {
        if (
          usedChars + item.chars <= charBudget &&
          usedBytes + item.bytes <= byteBudget
        ) {
          pickedCount = k + 1;
          chosenFooter = "";
        }
        break;
      }
      const remChars = charBudget - (usedChars + item.chars);
      const remBytes = byteBudget - (usedBytes + item.bytes);
      const candFooter =
        tier === "full"
          ? (() => {
              const full =
                nestedTotalCount > 0
                  ? `\n... (+${nextOmitted} more top-level symbols in L${suffixMinStart[k + 1]!}-L${suffixMaxEnd[k + 1]!} omitted, plus nested; use batch_search or read_file)`
                  : `\n... (+${nextOmitted} more top-level symbols in L${suffixMinStart[k + 1]!}-L${suffixMaxEnd[k + 1]!} omitted; use batch_search or read_file)`;
              return full.length <= remChars &&
                Buffer.byteLength(full, "utf8") <= remBytes
                ? full
                : null;
            })()
          : pickTopLevelOmissionFooter(
              nextOmitted,
              suffixMinStart[k + 1]!,
              suffixMaxEnd[k + 1]!,
              nestedTotalCount > 0,
              remChars,
              remBytes,
            );
      if (candFooter !== null) {
        usedChars += item.chars;
        usedBytes += item.bytes;
        pickedCount = k + 1;
        chosenFooter = candFooter;
      } else {
        break;
      }
    }
    return { pickedCount, footer: chosenFooter };
  };

  let packed = tryPackPrefixWithTier("full");
  if (packed.pickedCount === 0) {
    packed = tryPackPrefixWithTier("compact");
  }

  if (packed.pickedCount > 0) {
    const pickedLines = topIndices
      .slice(0, packed.pickedCount)
      .map((idx) => items[idx]!.line);
    return `${header}\n${pickedLines.join("\n")}${packed.footer}`;
  }

  // Zero top-level symbols fit alongside a footer: emit the richest footer that fits the budget
  const fallbackFooter =
    m > 0
      ? pickTopLevelOmissionFooter(
          m,
          suffixMinStart[0]!,
          suffixMaxEnd[0]!,
          nestedTotalCount > 0,
          charBudget - headerChars,
          byteBudget - headerBytes,
        )
      : null;
  return fallbackFooter ? `${header}${fallbackFooter}` : header;
}

export async function runReadSlices(
  input: ReadSlicesInput,
): Promise<{ text: string; isError: boolean }> {
  const corruptedItems: CorruptedItem[] = [];
  let outlines: string[] = [];
  if (input?.outlines !== undefined) {
    const parsedOutlines = parseMaybeJsonArray(input.outlines);
    if (!parsedOutlines.ok) {
      corruptedItems.push({
        label: "outlines",
        value: input.outlines,
        expected: "an array of file path strings",
      });
    } else {
      for (let i = 0; i < parsedOutlines.value.length; i++) {
        const item = parsedOutlines.value[i];
        if (typeof item !== "string" || !item.trim()) {
          corruptedItems.push({
            label: `outlines[${i}]`,
            value: item,
            expected: "a non-empty file path string",
          });
        }
      }
      if (corruptedItems.length === 0) {
        outlines = parsedOutlines.value as string[];
      }
    }
  }

  let slices: SliceRequest[] = [];
  let sliceFormatError: string | null = null;
  const parseSliceShorthand = (
    raw: string,
    label: string,
  ): SliceRequest | null => {
    const trimmed = raw.trim();
    const match = /^(.+):(\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)$/.exec(trimmed);
    if (!match || !match[1]!.trim()) {
      if (sliceFormatError === null) {
        sliceFormatError = `Error: ${label} must use 'path:start-end' or 'path:start1-end1,start2-end2' format (got ${JSON.stringify(raw)}).`;
      }
      return null;
    }
    const filePath = match[1]!.trim();
    const ranges: Array<[number, number]> = match[2]!
      .split(",")
      .map((part) => {
        const seg = part.trim();
        const dash = seg.indexOf("-");
        if (dash === -1) {
          const n = Number(seg);
          return [n, n] as [number, number];
        }
        return [Number(seg.slice(0, dash)), Number(seg.slice(dash + 1))] as [
          number,
          number,
        ];
      });
    return { path: filePath, ranges };
  };

  if (input?.slices !== undefined) {
    const parsedSlices = parseMaybeJsonArray(input.slices);
    if (!parsedSlices.ok) {
      corruptedItems.push({
        label: "slices",
        value: input.slices,
        expected: "an array of slice objects ({ path, ranges }) or 'path:start-end' strings",
      });
    } else {
      const normalizedSlices: SliceRequest[] = [];
      for (let i = 0; i < parsedSlices.value.length; i++) {
        const item = parsedSlices.value[i];
        if (typeof item === "string") {
          const parsed = parseSliceShorthand(item, `slices[${i}]`);
          if (parsed) normalizedSlices.push(parsed);
          continue;
        }
        if (!isPlainObject(item)) {
          corruptedItems.push({
            label: `slices[${i}]`,
            value: item,
            expected: "a slice object ({ path, ranges }) or 'path:start-end' string",
          });
          continue;
        }
        if (item.ranges !== undefined && !Array.isArray(item.ranges)) {
          corruptedItems.push({
            label: `slices[${i}].ranges`,
            value: item.ranges,
            expected: "an array of [startLine, endLine] pairs",
          });
        } else if (Array.isArray(item.ranges)) {
          for (let j = 0; j < item.ranges.length; j++) {
            const r = item.ranges[j];
            if (typeof r === "boolean" || r === null) {
              corruptedItems.push({
                label: `slices[${i}].ranges[${j}]`,
                value: r,
                expected: "a [startLine, endLine] pair",
              });
            }
          }
        }
        normalizedSlices.push(item as unknown as SliceRequest);
      }
      if (corruptedItems.length === 0) {
        slices.push(...normalizedSlices);
      }
    }
  }

  if (input?.lineRanges !== undefined) {
    const parsedSpecs = parseMaybeJsonArray(input.lineRanges);
    if (!parsedSpecs.ok) {
      corruptedItems.push({
        label: "lineRanges",
        value: input.lineRanges,
        expected: "an array of 'path:start-end' strings",
      });
    } else {
      const normalizedSpecs: SliceRequest[] = [];
      for (let i = 0; i < parsedSpecs.value.length; i++) {
        const item = parsedSpecs.value[i];
        if (item === null || typeof item === "boolean") {
          corruptedItems.push({
            label: `lineRanges[${i}]`,
            value: item,
            expected: "a 'path:start-end' string",
          });
        } else if (typeof item !== "string" || !item.trim()) {
          if (sliceFormatError === null) {
            sliceFormatError = `Error: lineRanges[${i}] must be a non-empty 'path:start-end' string.`;
          }
        } else {
          const parsed = parseSliceShorthand(item, `lineRanges[${i}]`);
          if (parsed) normalizedSpecs.push(parsed);
        }
      }
      if (corruptedItems.length === 0) {
        slices.push(...normalizedSpecs);
      }
    }
  }

  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "read_slices",
        items: corruptedItems,
        fallbackAdvice:
          "immediately fall back to parallel built-in read_file(StartLine, EndLine) calls.",
      }),
      isError: true,
    };
  }
  if (sliceFormatError !== null) {
    return { text: sliceFormatError, isError: true };
  }

  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines', 'slices', or 'lineRanges'.",
      isError: true,
    };
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  const rawMaxChars = Number(input.maxChars ?? 8_500);
  const maxChars = Number.isFinite(rawMaxChars)
    ? Math.max(1000, Math.min(DEFAULT_INLINE_MAX_BYTES, Math.trunc(rawMaxChars)))
    : 8_500;
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;

  const fileCache = new Map<string, { lines: string[]; size: number }>();
  async function loadLines(absPath: string): Promise<{ lines: string[]; size: number }> {
    const cached = fileCache.get(absPath);
    if (cached) return cached;
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size };
    fileCache.set(absPath, entry);
    return entry;
  }

  type RenderedSection =
    | { kind: "outline"; header: string; symbols: SymbolEntry[]; fullText: string }
    | { kind: "static"; fullText: string };

  const sectionEntries: RenderedSection[] = [];

  // Process outlines concurrently (extract full symbols without static per-file pre-cut)
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath): Promise<RenderedSection> => {
        const absPath = resolvePath(rawPath, baseCwd);
        const relPath =
          toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);
        try {
          const { lines } = await loadLines(absPath);
          const symbols = extractSymbolsFromLines(absPath, lines);
          const header = `## Outline: ${relPath} (${lines.length} lines)`;
          if (symbols.length === 0) {
            return {
              kind: "static",
              fullText: `${header}\n(no top-level symbols detected)`,
            };
          }
          const formatted = symbols.map(formatSymbolLine);
          return {
            kind: "outline",
            header,
            symbols,
            fullText: `${header}\n${formatted.join("\n")}`,
          };
        } catch (err) {
          return {
            kind: "static",
            fullText: `## Outline: ${relPath}\nERROR: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }),
    );
    sectionEntries.push(...outlineResults);
  }

  // Process slices concurrently
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req): Promise<RenderedSection> => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return {
            kind: "static",
            fullText: "## Slice: (invalid)\nERROR: 'path' must be a non-empty string",
          };
        }
        const absPath = resolvePath(req.path, baseCwd);
        const relPath =
          toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);

        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return {
            kind: "static",
            fullText: `## Slice: ${relPath}\nERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`,
          };
        }

        try {
          const { lines } = await loadLines(absPath);
          const totalLines = lines.length;
          const blocks: string[] = [];

          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`,
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`,
              );
              continue;
            }

            const width = String(end).length;
            const snippet: string[] = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }

          return {
            kind: "static",
            fullText: `## Slice: ${relPath} (${totalLines} lines)\n${blocks.join("\n")}`,
          };
        } catch (err) {
          return {
            kind: "static",
            fullText: `## Slice: ${relPath}\nERROR: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }),
    );
    sectionEntries.push(...sliceResults);
  }

  const separator = "\n\n";
  const sepChars = separator.length * Math.max(0, sectionEntries.length - 1);
  const sepBytes =
    Buffer.byteLength(separator, "utf8") * Math.max(0, sectionEntries.length - 1);

  const charSizes = sectionEntries.map((s) => s.fullText.length);
  const byteSizes = sectionEntries.map((s) =>
    Buffer.byteLength(s.fullText, "utf8"),
  );
  const rawChars = charSizes.reduce((sum, n) => sum + n, 0) + sepChars;
  const rawBytes = byteSizes.reduce((sum, n) => sum + n, 0) + sepBytes;
  const isOverBudget = rawChars > maxChars || rawBytes > maxBytes;

  if (!isOverBudget) {
    return {
      text: sectionEntries.map((s) => s.fullText).join(separator),
      isError: false,
    };
  }

  const activeTip =
    slices.length > 0
      ? SLICE_TRUNCATION_TIP
      : outlines.length > 20
        ? OUTLINE_BATCH_TIP
        : null;
  const applyTip = activeTip !== null && maxChars > activeTip.length + 200;
  const tipChars = applyTip ? activeTip.length : 0;
  const tipBytes = applyTip ? Buffer.byteLength(activeTip, "utf8") : 0;
  const bodyMaxChars = maxChars - tipChars;
  const bodyMaxBytes = maxBytes - tipBytes;

  const availChars = Math.max(0, bodyMaxChars - sepChars);
  const availBytes = Math.max(0, bodyMaxBytes - sepBytes);
  const charBudgets = computeWaterFillBudgets(charSizes, availChars);
  const byteBudgets = computeWaterFillBudgets(byteSizes, availBytes);

  const sections = sectionEntries.map((entry, idx) => {
    if (
      entry.kind === "outline" &&
      (charSizes[idx]! > charBudgets[idx]! || byteSizes[idx]! > byteBudgets[idx]!)
    ) {
      return packOutlineToBudget(
        entry.header,
        entry.symbols,
        charBudgets[idx]!,
        byteBudgets[idx]!,
      );
    }
    return entry.fullText;
  });

  const body = fitSectionsToByteBudget(
    sections,
    bodyMaxChars,
    bodyMaxBytes,
    separator,
  );

  return {
    text: applyTip ? `${body}${activeTip}` : body,
    isError: false,
  };
}

export async function runQuickOutline(
  input: QuickOutlineInput,
): Promise<{ text: string; isError: boolean }> {
  const rawInput = input as Record<string, unknown> | undefined;
  const rawPaths =
    rawInput?.paths !== undefined
      ? rawInput.paths
      : rawInput?.outlines !== undefined
        ? rawInput.outlines
        : rawInput?.files;

  if (rawPaths === undefined) {
    return {
      text: "Error: provide at least one file path in 'paths'.",
      isError: true,
    };
  }

  const parsedPaths = parseMaybeJsonArray(rawPaths);
  const corruptedItems: CorruptedItem[] = [];
  let firstInvalidError: string | null = null;
  if (!parsedPaths.ok) {
    if (
      parsedPaths.kind === "corrupted_literal" ||
      rawPaths === null ||
      typeof rawPaths === "boolean"
    ) {
      corruptedItems.push({
        label: "paths",
        value: parsedPaths.kind === "corrupted_literal" ? parsedPaths.value : rawPaths,
        expected: "an array of file path strings",
      });
    } else {
      firstInvalidError = `Error: 'paths' must be an array of non-empty file path strings (${parsedPaths.detail}).`;
    }
  } else {
    for (let i = 0; i < parsedPaths.value.length; i++) {
      const item = parsedPaths.value[i];
      if (item === null || typeof item === "boolean") {
        corruptedItems.push({
          label: `paths[${i}]`,
          value: item,
          expected: "a non-empty file path string",
        });
      } else if (typeof item !== "string" || !item.trim()) {
        if (firstInvalidError === null) {
          firstInvalidError = `Error: paths[${i}] must be a non-empty file path string.`;
        }
      }
    }
  }

  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "quick_outline",
        items: corruptedItems,
        fallbackAdvice:
          "immediately fall back to parallel built-in read_file(StartLine, EndLine) calls.",
      }),
      isError: true,
    };
  }
  if (firstInvalidError !== null) {
    return { text: firstInvalidError, isError: true };
  }

  const paths = (parsedPaths as { ok: true; value: string[] }).value;
  if (paths.length === 0) {
    return {
      text: "Error: provide at least one file path in 'paths'.",
      isError: true,
    };
  }
  if (paths.length > MAX_OUTLINES) {
    return {
      text: `Error: limit exceeded (max ${MAX_OUTLINES} paths per call).`,
      isError: true,
    };
  }

  return runReadSlices({
    cwd: input?.cwd,
    outlines: paths,
    maxChars: input?.maxChars,
  });
}
