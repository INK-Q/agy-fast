/**
 * Lightweight case-insensitive subsequence path matcher and ranker.
 */

export interface FuzzyMatchResult { path: string; score: number }

function findContiguousIndex(haystack: string[], needle: string[]): number {
  const maxStart = haystack.length - needle.length;
  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isWordBoundaryAt(rawTarget: string, idx: number): boolean {
  const next = idx + 1 < rawTarget.length ? rawTarget.charCodeAt(idx + 1) : 0;
  // Require at least a 2-char identifier/word segment so `_x_y_z` noise gets no word bonus
  const nextIsWord =
    (next >= 97 && next <= 122) ||
    (next >= 65 && next <= 90) ||
    (next >= 48 && next <= 57);
  if (!nextIsWord) return false;
  if (idx <= 0) return true;
  const prev = rawTarget.charCodeAt(idx - 1);
  // '/', '-', '_', '.', ' '
  if (prev === 47 || prev === 45 || prev === 95 || prev === 46 || prev === 32) {
    return true;
  }
  const cur = rawTarget.charCodeAt(idx);
  // camelCase transition: lower -> UPPER
  return prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90;
}

/** Compute subsequence span cost (smaller is better); operates on Unicode code points. */
export function subsequenceCost(needle: string, haystack: string): number | undefined {
  if (!needle) return 2147483647;

  // Zero-allocation ASCII fast path (covers ~99.9% of source file paths)
  if (isAscii(needle) && isAscii(haystack)) {
    const query = needle.toLowerCase();
    const lowered = haystack.toLowerCase();
    const contiguousAt = lowered.indexOf(query);
    if (contiguousAt >= 0) {
      return contiguousAt === 0 ? -100 : -60 + Math.min(25, contiguousAt);
    }
    const qLen = query.length;
    const hLen = lowered.length;
    const firstCode = query.charCodeAt(0);
    let bestCost: number | undefined;
    let searchFrom = 0;
    let attempts = 0;

    while (searchFrom <= hLen - qLen && attempts < 12) {
      const startPos = lowered.indexOf(query[0]!, searchFrom);
      if (startPos < 0 || startPos > hLen - qLen) break;
      attempts++;
      searchFrom = startPos + 1;

      let cursor = startPos + 1;
      let prevMatch = startPos;
      let consecutiveHits = 0;
      let boundaryHits = isWordBoundaryAt(haystack, startPos) ? 1 : 0;
      let failed = false;

      for (let i = 1; i < qLen; i++) {
        const targetCode = query.charCodeAt(i);
        while (cursor < hLen && lowered.charCodeAt(cursor) !== targetCode) cursor++;
        if (cursor === hLen) {
          failed = true;
          break;
        }
        if (cursor === prevMatch + 1) {
          consecutiveHits++;
        } else if (isWordBoundaryAt(haystack, cursor)) {
          boundaryHits++;
        }
        prevMatch = cursor;
        cursor++;
      }
      if (failed) break;

      const gapPenalty = Math.max(0, prevMatch - startPos + 1 - qLen) * 2;
      const bonus =
        (startPos === 0 ? 12 : 0) +
        Math.min(36, consecutiveHits * 9 + boundaryHits * 7);
      const cost = Math.max(-55, gapPenalty - bonus);
      if (bestCost === undefined || cost < bestCost) {
        bestCost = cost;
      }
      if (firstCode < 0) break;
    }
    return bestCost;
  }

  const lowered = [...haystack.toLowerCase()];
  const query = [...needle.toLowerCase()];
  const contiguousAt = findContiguousIndex(lowered, query);
  if (contiguousAt >= 0) {
    return contiguousAt === 0 ? -100 : -60 + Math.min(25, contiguousAt);
  }
  let cursor = 0;
  let last = -1;
  for (const ch of query) {
    while (cursor < lowered.length && lowered[cursor] !== ch) cursor++;
    if (cursor === lowered.length) return undefined;
    last = cursor++;
  }
  let backCursor = last;
  let first = last;
  for (let i = query.length - 1; i >= 0; i--) {
    const ch = query[i]!;
    while (backCursor >= 0 && lowered[backCursor] !== ch) backCursor--;
    first = backCursor--;
  }
  return Math.max(0, last - first + 1 - query.length) - (first === 0 ? 20 : 0);
}

// Higher-is-better path ranking score, with -1 as the non-match sentinel.
function scoreSubsequence(query: string, target: string): number {
  const cost = subsequenceCost(query, target);
  return cost === undefined ? -1 : Math.max(1, 1000 - cost);
}

interface PreparedFuzzyToken {
  raw: string;
  lower: string;
  hasSlash: boolean;
}

function prepareFuzzyTokens(query: string): PreparedFuzzyToken[] {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return [];
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({
      raw,
      lower: raw.toLowerCase(),
      hasSlash: raw.includes("/"),
    }));
}

function scorePreparedTokens(
  tokens: PreparedFuzzyToken[],
  candidatePosix: string,
): number {
  if (tokens.length === 0) return -1;
  const slashIdx = candidatePosix.lastIndexOf("/");
  const basename = slashIdx === -1 ? candidatePosix : candidatePosix.slice(slashIdx + 1);
  const lowerBase = basename.toLowerCase();

  let totalScore = 0;
  for (const tok of tokens) {
    const fullScore = scoreSubsequence(tok.raw, candidatePosix);
    if (fullScore < 0) return -1;
    const baseScore = !tok.hasSlash ? scoreSubsequence(tok.raw, basename) : -1;
    // Matching the filename itself gets a strong boost over matching parent dirs only
    totalScore += baseScore >= 0 ? Math.max(fullScore, baseScore + 45) : fullScore;
    if (lowerBase === tok.lower) totalScore += 60;
  }

  return totalScore;
}

export function fuzzyScorePath(query: string, candidatePosix: string): number {
  return scorePreparedTokens(prepareFuzzyTokens(query), candidatePosix);
}

export function rankFuzzyPaths(
  query: string,
  candidates: string[],
  maxResults: number,
): { matches: FuzzyMatchResult[]; totalMatched: number } {
  const tokens = prepareFuzzyTokens(query);
  if (tokens.length === 0) return { matches: [], totalMatched: 0 };
  const scored: FuzzyMatchResult[] = [];
  for (const candidate of candidates) {
    const score = scorePreparedTokens(tokens, candidate);
    if (score >= 0) scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    matches: scored.slice(0, maxResults),
    totalMatched: scored.length,
  };
}
