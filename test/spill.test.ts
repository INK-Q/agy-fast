import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runApplyEdits } from "../src/tools/apply-edits.js";
import { runBatchSearch } from "../src/tools/batch-search.js";
import { runChecks } from "../src/tools/run-checks.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  truncateHeadTailWithByteNotice,
  truncateWithByteNotice,
} from "../src/utils/output-filter.js";
import {
  SPILL_FILENAME_RE,
  SPILL_MAX_FILE_BYTES,
  SPILL_MAX_FILES,
  SPILL_TTL_MS,
  capSpillContent,
  isSpillEnabled,
  resolveSpillDir,
  rotateSpillFiles,
  writeSpillFile,
} from "../src/utils/spill.js";

const nodeBin = JSON.stringify(process.execPath);
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SPILL_FOOTER_RE =
  /\n\.\.\. \[Full output saved: (.+?) \([^)]+\); inspect with read_file\(StartLine, EndLine\) or batch_search\]$/;

function extractSpillPath(text: string): string | null {
  const match = SPILL_FOOTER_RE.exec(text);
  return match ? match[1]! : null;
}

async function listSpillFiles(cacheDir: string): Promise<string[]> {
  const spillDir = path.join(cacheDir, "spills");
  try {
    return (await fsp.readdir(spillDir)).filter((name) => SPILL_FILENAME_RE.test(name)).sort();
  } catch {
    return [];
  }
}

async function withIsolatedSpillEnv<T>(
  fn: (ctx: { rootDir: string; cacheDir: string }) => Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agy-fast-spill-test-"));
  const cacheDir = path.join(rootDir, "cache");
  const savedKeys = new Set([
    "AGY_FAST_CACHE_DIR",
    "AGY_FAST_SPILL",
    "GEMINI_HOME",
    ...Object.keys(extraEnv),
  ]);
  const prev = new Map<string, string | undefined>();
  for (const key of savedKeys) {
    prev.set(key, process.env[key]);
  }
  process.env.AGY_FAST_CACHE_DIR = cacheDir;
  delete process.env.AGY_FAST_SPILL;
  delete process.env.GEMINI_HOME;
  for (const [key, val] of Object.entries(extraEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  try {
    return await fn({ rootDir, cacheDir });
  } finally {
    for (const [key, val] of prev.entries()) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
}

describe("spill-on-overflow (Issue #80)", () => {
  it("spills at most 1 full file for run_checks in compact and full modes (ASCII + multibyte) and skips when not truncated", async () => {
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      // Write fixture scripts to disk so Windows cmd.exe never mangles quotes, escapes, or UTF-8 CJK/emoji
      const scriptsDir = path.join(rootDir, "scripts");
      await fsp.mkdir(scriptsDir, { recursive: true });
      const writeScript = async (name: string, lines: string[]): Promise<string> => {
        const scriptPath = path.join(scriptsDir, name);
        await fsp.writeFile(scriptPath, `${lines.join("\n")}\n`, "utf8");
        return `${nodeBin} ${JSON.stringify(scriptPath)}`;
      };

      // 1. Non-truncated compact & full calls write 0 spill files
      const smallCompact = await runChecks({
        outputMode: "compact",
        commands: [
          { name: "ok-pass", command: await writeScript("ok-pass.mjs", ["console.log('All 5 tests passed');"]) },
          { name: "ok-fail", command: await writeScript("ok-fail.mjs", ["console.error('Error: tiny');", "process.exitCode = 1;"]) },
        ],
      });
      assert.equal(smallCompact.isError, false);
      assert.equal(extractSpillPath(smallCompact.text), null);
      assert.deepEqual(await listSpillFiles(cacheDir), []);

      const smallFull = await runChecks({
        outputMode: "full",
        commands: [
          { name: "small-full", command: await writeScript("small-full.mjs", ["console.log('alpha');", "console.log('beta');"]) },
        ],
      });
      assert.equal(smallFull.isError, false);
      assert.equal(extractSpillPath(smallFull.text), null);
      assert.deepEqual(await listSpillFiles(cacheDir), []);

      // 2. Truncated compact mode (ASCII > 15 KB across 2 commands -> exactly 1 spill file)
      const passOneCmd = await writeScript("pass-one.mjs", [
        "console.log('PASS_CMD_RAW_LINE_1');",
        "console.log('PASS_SUMMARY: 10 passed');",
      ]);
      const asciiFailCmd = await writeScript("ascii-fail.mjs", [
        "console.error('ROOT_HEAD_MARKER: first error line');",
        "for (let i = 0; i < 220; i++) console.error('Error: COMPACT_MID_' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(60));",
        "console.error('TAIL_END_MARKER: 222 errors total');",
        "process.exitCode = 1;",
      ]);
      const compactRes = await runChecks({
        outputMode: "compact",
        commands: [
          { name: "pass-one", command: passOneCmd },
          { name: "fail-big", command: asciiFailCmd },
        ],
      });
      assert.equal(compactRes.isError, false);
      assert.ok(compactRes.text.length <= 8_000, `got ${compactRes.text.length}`);
      assert.ok(Buffer.byteLength(compactRes.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
      assert.match(compactRes.text, /ROOT_HEAD_MARKER/);
      assert.match(compactRes.text, /TAIL_END_MARKER/);
      const compactSpillPath = extractSpillPath(compactRes.text);
      assert.ok(compactSpillPath, `Expected spill footer at end:\n${compactRes.text}`);
      assert.equal((await listSpillFiles(cacheDir)).length, 1);
      const compactSpillText = await fsp.readFile(compactSpillPath, "utf8");
      assert.match(compactSpillText, /PASS_CMD_RAW_LINE_1/);
      assert.match(compactSpillText, /COMPACT_MID_110/);
      assert.match(compactSpillText, /TAIL_END_MARKER/);

      // 3. Truncated full mode (ASCII > 15 KB across 2 commands -> exactly 1 more spill file, footer AFTER head-tail)
      const full1Cmd = await writeScript("full-1.mjs", [
        "for (let i = 0; i < 160; i++) console.log('FULL_ONE_' + i + '_' + 'a'.repeat(55));",
      ]);
      const full2Cmd = await writeScript("full-2.mjs", [
        "for (let i = 0; i < 160; i++) console.log('FULL_TWO_' + i + '_' + 'b'.repeat(55));",
      ]);
      const fullRes = await runChecks({
        outputMode: "full",
        commands: [
          { name: "full-1", command: full1Cmd },
          { name: "full-2", command: full2Cmd },
        ],
      });
      assert.equal(fullRes.isError, false);
      assert.ok(fullRes.text.length <= 8_000);
      assert.ok(Buffer.byteLength(fullRes.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
      assert.match(fullRes.text, /\[truncated: folded /);
      const fullSpillPath = extractSpillPath(fullRes.text);
      assert.ok(fullSpillPath, `Expected spill footer at end:\n${fullRes.text}`);
      assert.equal((await listSpillFiles(cacheDir)).length, 2);
      const fullSpillText = await fsp.readFile(fullSpillPath, "utf8");
      assert.match(fullSpillText, /FULL_ONE_80_/);
      assert.match(fullSpillText, /FULL_TWO_80_/);

      // 4. Truncated multibyte CJK + 4-byte emoji in both compact and full modes (<= 8800 UTF-8 bytes, no lone surrogates)
      const cjkCmd = await writeScript("cjk-fail.mjs", [
        "console.error('Error: 中文头部根因🚀_CJK_HEAD');",
        "for (let i = 0; i < 160; i++) console.error('Error: 中文编译详情🔥_' + i + '_' + '测试内容🚀'.repeat(12));",
        "console.error('Error: 中文尾部汇总✅_CJK_TAIL');",
        "process.exitCode = 1;",
      ]);
      for (const mode of ["compact", "full"] as const) {
        const res = await runChecks({
          outputMode: mode,
          commands: [{ name: `cjk-${mode}`, command: cjkCmd }],
        });
        assert.equal(res.isError, false);
        assert.ok(
          Buffer.byteLength(res.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES,
          `mode=${mode} exceeded 8800B: ${Buffer.byteLength(res.text, "utf8")}`,
        );
        assert.equal(LONE_SURROGATE_RE.test(res.text), false);
        assert.doesNotMatch(res.text, /\uFFFD/);
        const spillPath = extractSpillPath(res.text);
        assert.ok(spillPath, `Expected spill footer for cjk-${mode}`);
        const raw = await fsp.readFile(spillPath, "utf8");
        assert.match(raw, /中文编译详情🔥_80_/);
        assert.match(raw, /中文尾部汇总✅_CJK_TAIL/);
      }
      assert.equal((await listSpillFiles(cacheDir)).length, 4);
    });
  });

  it("spills raw un-compacted verify output for apply_edits when truncated and skips when small", async () => {
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const workDir = path.join(rootDir, "repo");
      await fsp.mkdir(workDir, { recursive: true });
      await fsp.writeFile(path.join(workDir, "app.ts"), "export const v = 1;\n", "utf8");

      // 1. Small verify output -> 0 spill files
      const smallVerify = await runApplyEdits({
        cwd: workDir,
        edits: [{ path: "app.ts", hunks: [{ target: "v = 1", replacement: "v = 2" }] }],
        verify: `${nodeBin} -e "console.log('verify ok')"`,
      });
      assert.equal(smallVerify.isError, false);
      assert.equal(extractSpillPath(smallVerify.text), null);
      assert.deepEqual(await listSpillFiles(cacheDir), []);

      // 2. Truncated verify output with noise lines stripped from inline response -> raw output spilled in full
      const rawVerifyFile = path.join(rootDir, "raw-verify.mjs");
      await fsp.writeFile(
        rawVerifyFile,
        [
          'for (let i = 0; i < 40; i++) console.log(JSON.stringify({ level: 30, msg: "RAW_PINO_NOISE_" + i, pad: "p".repeat(50) }));',
          'console.error("VERIFY_ROOT_ERROR: type mismatch in src/app.ts");',
          'for (let i = 0; i < 160; i++) console.error("Error: VERIFY_DETAIL_" + String(i).padStart(3, "0") + " " + "详情中文🚀".repeat(8));',
          'console.error("VERIFY_FINAL_TAIL: 161 errors");',
          "process.exitCode = 1;",
        ].join("\n") + "\n",
        "utf8",
      );
      const truncVerify = await runApplyEdits({
        cwd: workDir,
        edits: [{ path: "app.ts", hunks: [{ target: "v = 2", replacement: "v = 3" }] }],
        verify: `${nodeBin} ${JSON.stringify(rawVerifyFile)}`,
      });
      assert.equal(truncVerify.isError, false);
      assert.ok(
        Buffer.byteLength(truncVerify.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES,
        `Exceeded 8800B: ${Buffer.byteLength(truncVerify.text, "utf8")}`,
      );
      assert.equal(LONE_SURROGATE_RE.test(truncVerify.text), false);
      assert.doesNotMatch(truncVerify.text, /RAW_PINO_NOISE_15/);
      const spillPath = extractSpillPath(truncVerify.text);
      assert.ok(spillPath, `Expected spill footer:\n${truncVerify.text}`);
      assert.equal((await listSpillFiles(cacheDir)).length, 1);

      // Verify spill file contains FULL RAW output (including stripped Pino noise & middle lines!)
      const rawSpill = await fsp.readFile(spillPath, "utf8");
      assert.match(rawSpill, /RAW_PINO_NOISE_15/);
      assert.match(rawSpill, /VERIFY_DETAIL_080/);
      assert.match(rawSpill, /VERIFY_FINAL_TAIL: 161 errors/);
    });
  });

  it("spills at most 1 combined file per batch_search call across oversized ASCII and CJK multi-query results", async () => {
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const searchDir = path.join(rootDir, "search-proj");
      await fsp.mkdir(searchDir, { recursive: true });
      await fsp.writeFile(
        path.join(searchDir, "ascii.ts"),
        Array.from(
          { length: 180 },
          (_, i) => `export const asciiRow${i} = "ASCII_SPILL_HIT_${String(i).padStart(3, "0")}_${"x".repeat(70)}";`,
        ).join("\n") + "\n",
        "utf8",
      );
      await fsp.writeFile(
        path.join(searchDir, "cjk.ts"),
        Array.from(
          { length: 140 },
          (_, i) => `export const cjkRow${i} = "CJK_SPILL_HIT_${String(i).padStart(3, "0")}_中文搜索结果🚀_${"数据内容".repeat(12)}";`,
        ).join("\n") + "\n",
        "utf8",
      );
      await fsp.writeFile(path.join(searchDir, "small.ts"), "export const SMALL_ONLY = 1;\n", "utf8");

      // 1. Non-truncated query -> 0 spill files
      const smallSearch = await runBatchSearch({
        cwd: searchDir,
        queries: [{ type: "text", pattern: "SMALL_ONLY", path: "small.ts" }],
      });
      assert.equal(smallSearch.isError, false);
      assert.equal(extractSpillPath(smallSearch.text), null);
      assert.deepEqual(await listSpillFiles(cacheDir), []);

      // 2. Oversized multi-query ASCII (3 queries) -> exactly 1 spill file containing all sections
      const asciiMulti = await runBatchSearch({
        cwd: searchDir,
        queries: [
          { type: "text", pattern: "ASCII_SPILL_HIT", path: "ascii.ts", maxResults: 180 },
          { type: "text", pattern: "SMALL_ONLY", path: "small.ts" },
          { type: "text", pattern: "asciiRow", path: "ascii.ts", maxResults: 180 },
        ],
      });
      assert.equal(asciiMulti.isError, false);
      assert.ok(asciiMulti.text.length <= 8_500);
      assert.ok(Buffer.byteLength(asciiMulti.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
      assert.equal(asciiMulti.text.split("\n\n").length, 3);
      const asciiSpill = extractSpillPath(asciiMulti.text);
      assert.ok(asciiSpill, `Expected spill footer:\n${asciiMulti.text.slice(-300)}`);
      assert.equal((await listSpillFiles(cacheDir)).length, 1);
      const asciiRaw = await fsp.readFile(asciiSpill, "utf8");
      assert.match(asciiRaw, /## Query 1/);
      assert.match(asciiRaw, /## Query 2/);
      assert.match(asciiRaw, /## Query 3/);
      assert.match(asciiRaw, /ASCII_SPILL_HIT_150/);

      // 3. Oversized multi-query CJK/emoji -> exactly 1 more spill file, <= 8800 UTF-8 bytes
      const cjkMulti = await runBatchSearch({
        cwd: searchDir,
        queries: [
          { type: "text", pattern: "CJK_SPILL_HIT", path: "cjk.ts", maxResults: 140 },
          { type: "text", pattern: "SMALL_ONLY", path: "small.ts" },
        ],
      });
      assert.equal(cjkMulti.isError, false);
      assert.ok(
        Buffer.byteLength(cjkMulti.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES,
        `Exceeded 8800B: ${Buffer.byteLength(cjkMulti.text, "utf8")}`,
      );
      assert.equal(LONE_SURROGATE_RE.test(cjkMulti.text), false);
      const cjkSpill = extractSpillPath(cjkMulti.text);
      assert.ok(cjkSpill, `Expected spill footer for CJK batch_search`);
      assert.equal((await listSpillFiles(cacheDir)).length, 2);
      const cjkRaw = await fsp.readFile(cjkSpill, "utf8");
      assert.match(cjkRaw, /CJK_SPILL_HIT_120_中文搜索结果🚀/);
    });
  });

  it("enforces small-budget safety: omits footer and writes 0 spill files when budget is too small", async () => {
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const workDir = path.join(rootDir, "small-budget");
      await fsp.mkdir(workDir, { recursive: true });
      await fsp.writeFile(
        path.join(workDir, "big.ts"),
        Array.from({ length: 80 }, (_, i) => `const line_${i} = "SMALL_BUDGET_HIT_${i}_${"z".repeat(50)}";`).join("\n") + "\n",
        "utf8",
      );

      // run_checks with maxChars: 500
      const rc = await runChecks({
        outputMode: "full",
        maxChars: 500,
        commands: [
          {
            name: "tiny-cap",
            command: `${nodeBin} -e "for (let i = 0; i < 80; i++) console.log('LINE_' + i + '_' + 'x'.repeat(40))"`,
          },
        ],
      });
      assert.equal(rc.isError, false);
      assert.ok(rc.text.length <= 500, `got ${rc.text.length}`);
      assert.match(rc.text, /\[truncated:/);
      assert.equal(extractSpillPath(rc.text), null);

      // batch_search with maxChars: 500
      const bs = await runBatchSearch({
        cwd: workDir,
        maxChars: 500,
        queries: [{ type: "text", pattern: "SMALL_BUDGET_HIT", path: "big.ts", maxResults: 80 }],
      });
      assert.equal(bs.isError, false);
      assert.ok(bs.text.length <= 500, `got ${bs.text.length}`);
      assert.match(bs.text, /\[truncated:/);
      assert.equal(extractSpillPath(bs.text), null);

      // apply_edits with maxVerifyChars: 300
      const ae = await runApplyEdits({
        cwd: workDir,
        maxVerifyChars: 300,
        edits: [{ path: "big.ts", hunks: [{ target: "line_0 =", replacement: "line_zero =" }] }],
        verify: `${nodeBin} -e "for (let i = 0; i < 80; i++) console.error('Error: tiny verify ' + i + ' ' + 'y'.repeat(40)); process.exit(1)"`,
      });
      assert.equal(ae.isError, false);
      assert.ok(Buffer.byteLength(ae.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
      assert.equal(extractSpillPath(ae.text), null);

      // Zero spill files AND spills directory not even created
      assert.deepEqual(await listSpillFiles(cacheDir), []);
      assert.equal(fs.existsSync(path.join(cacheDir, "spills")), false);
    });
  });

  it("enforces security & privacy guardrails (private cache dir, kill switch, anti-symlink, POSIX 0o700/0o600, fail-open)", async () => {
    // 1. Private cache dir resolution precedence (NEVER /tmp)
    assert.equal(
      resolveSpillDir({ AGY_FAST_CACHE_DIR: "/custom/cache", GEMINI_HOME: "/gem", HOME: "/home/u" }, "linux"),
      path.join(path.resolve("/custom/cache"), "spills"),
    );
    assert.equal(
      resolveSpillDir({ AGY_FAST_CACHE_DIR: "   ", GEMINI_HOME: "/gem-home", HOME: "/home/u" }, "linux"),
      path.join(path.resolve("/gem-home"), "cache", "agy-fast", "spills"),
    );
    assert.equal(
      resolveSpillDir({ HOME: "/home/alice" }, "linux"),
      path.join(path.resolve("/home/alice"), ".gemini", "cache", "agy-fast", "spills"),
    );
    assert.equal(
      resolveSpillDir({ USERPROFILE: "C:\\Users\\Alice" }, "win32"),
      path.join(path.resolve("C:\\Users\\Alice"), ".gemini", "cache", "agy-fast", "spills"),
    );

    // 2. Kill switch AGY_FAST_SPILL
    for (const offVal of ["0", "off", "OFF", "false", "False", "no", " NO "]) {
      assert.equal(isSpillEnabled({ AGY_FAST_SPILL: offVal }), false, `expected disabled for ${offVal}`);
    }
    for (const onVal of [undefined, "", "1", "on", "true", "yes"]) {
      assert.equal(isSpillEnabled({ AGY_FAST_SPILL: onVal }), true, `expected enabled for ${String(onVal)}`);
    }

    await withIsolatedSpillEnv(
      async ({ cacheDir }) => {
        const res = await runChecks({
          outputMode: "full",
          commands: [
            { name: "kill-switch", command: `${nodeBin} -e "console.log('x'.repeat(12000))"` },
          ],
        });
        assert.equal(res.isError, false);
        assert.equal(extractSpillPath(res.text), null);
        assert.deepEqual(await listSpillFiles(cacheDir), []);
        assert.equal(fs.existsSync(path.join(cacheDir, "spills")), false);
      },
      { AGY_FAST_SPILL: "0" },
    );

    // 3. POSIX permissions (0o700 dir, 0o600 file), anti-symlink checks, and fail-open behavior
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const written = writeSpillFile({
        tool: "run_checks",
        rawContent: "sensitive tool output\n",
      });
      assert.ok(written, "expected spill write to succeed");
      assert.match(written.fileName, SPILL_FILENAME_RE);

      if (process.platform !== "win32") {
        const dirMode = fs.lstatSync(path.join(cacheDir, "spills")).mode & 0o777;
        const fileMode = fs.lstatSync(written.filePath).mode & 0o777;
        assert.equal(dirMode, 0o700, `Expected 0o700 spillDir, got 0o${dirMode.toString(8)}`);
        assert.equal(fileMode, 0o600, `Expected 0o600 spill file, got 0o${fileMode.toString(8)}`);
      }

      // Symlink planted at spills dir -> refuses to write into victim dir & fails open
      const victimDir = path.join(rootDir, "victim");
      await fsp.mkdir(victimDir, { recursive: true });
      const symCache = path.join(rootDir, "sym-cache");
      await fsp.mkdir(symCache, { recursive: true });
      const symSpills = path.join(symCache, "spills");
      let symlinkSupported = true;
      try {
        await fsp.symlink(victimDir, symSpills, process.platform === "win32" ? "junction" : "dir");
      } catch {
        symlinkSupported = false;
      }
      if (symlinkSupported) {
        const blocked = writeSpillFile({
          tool: "run_checks",
          rawContent: "must not reach victim",
          env: { AGY_FAST_CACHE_DIR: symCache },
        });
        assert.equal(blocked, null);
        assert.deepEqual(await fsp.readdir(victimDir), []);

        // End-to-end tool call fails open with normal truncated output
        process.env.AGY_FAST_CACHE_DIR = symCache;
        const failOpenRes = await runChecks({
          outputMode: "full",
          commands: [{ name: "sym-test", command: `${nodeBin} -e "console.log('S'.repeat(12000))"` }],
        });
        assert.equal(failOpenRes.isError, false);
        assert.equal(extractSpillPath(failOpenRes.text), null);
        assert.ok(Buffer.byteLength(failOpenRes.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
        assert.deepEqual(await fsp.readdir(victimDir), []);

        // Symlink planted at parent cacheDir itself -> also refuses & fails open
        const symParent = path.join(rootDir, "sym-parent-cache");
        await fsp.symlink(victimDir, symParent, process.platform === "win32" ? "junction" : "dir");
        const blockedParent = writeSpillFile({
          tool: "batch_search",
          rawContent: "must not reach victim via parent",
          env: { AGY_FAST_CACHE_DIR: symParent },
        });
        assert.equal(blockedParent, null);
        assert.deepEqual(await fsp.readdir(victimDir), []);
      }

      // Regular file blocking spills dir path -> fails open cleanly
      const fileBlockerCache = path.join(rootDir, "file-blocker-cache");
      await fsp.mkdir(fileBlockerCache, { recursive: true });
      await fsp.writeFile(path.join(fileBlockerCache, "spills"), "not a dir", "utf8");
      assert.equal(
        writeSpillFile({
          tool: "apply_edits",
          rawContent: "blocked by regular file",
          env: { AGY_FAST_CACHE_DIR: fileBlockerCache },
        }),
        null,
      );

      // GEMINI_HOME precedence when AGY_FAST_CACHE_DIR is unset
      const customGemHome = path.join(rootDir, "gem-home");
      await fsp.mkdir(customGemHome, { recursive: true });
      const gemWritten = writeSpillFile({
        tool: "batch_search",
        rawContent: "gemini home spill\n",
        env: { GEMINI_HOME: customGemHome },
      });
      assert.ok(gemWritten);
      assert.equal(
        path.dirname(gemWritten.filePath),
        path.join(customGemHome, "cache", "agy-fast", "spills"),
      );

      // Read-only cacheDir on non-root POSIX -> fails open cleanly without turning tool result into an error
      if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
        const roCache = path.join(rootDir, "ro-cache");
        await fsp.mkdir(roCache, { recursive: true, mode: 0o500 });
        try {
          fs.chmodSync(roCache, 0o500);
          process.env.AGY_FAST_CACHE_DIR = roCache;
          const roRes = await runChecks({
            outputMode: "full",
            commands: [{ name: "ro-failopen", command: `${nodeBin} -e "console.log('R'.repeat(12000))"` }],
          });
          assert.equal(roRes.isError, false);
          assert.equal(extractSpillPath(roRes.text), null);
          assert.ok(Buffer.byteLength(roRes.text, "utf8") <= DEFAULT_INLINE_MAX_BYTES);
        } finally {
          fs.chmodSync(roCache, 0o700);
        }
      }
    });
  });

  it("caps spill files at <= 2 MiB cleanly and rotates deterministically (>20 files, same-ms ties, 24h TTL)", async () => {
    // 1. > 2 MiB multibyte payload is capped <= 2 MiB without lone surrogates
    const unit = "中文测试🚀ABCD"; // 16 UTF-8 bytes per unit
    const bigRaw = unit.repeat(Math.ceil((SPILL_MAX_FILE_BYTES + 200_000) / Buffer.byteLength(unit, "utf8")));
    const capped = capSpillContent(bigRaw);
    assert.equal(capped.capped, true);
    assert.ok(capped.originalBytes > SPILL_MAX_FILE_BYTES);
    assert.ok(capped.bytes <= SPILL_MAX_FILE_BYTES, `got ${capped.bytes}`);
    assert.equal(Buffer.byteLength(capped.payload, "utf8"), capped.bytes);
    assert.match(capped.payload, /\[spill capped at 2 MiB; original \d+ bytes\]/);
    assert.equal(LONE_SURROGATE_RE.test(capped.payload), false);

    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const writtenBig = writeSpillFile({
        tool: "run_checks",
        rawContent: bigRaw,
      });
      assert.ok(writtenBig);
      assert.equal(writtenBig.capped, true);
      assert.equal(path.dirname(writtenBig.filePath), path.join(cacheDir, "spills"));
      const diskBytes = fs.statSync(writtenBig.filePath).size;
      assert.ok(diskBytes <= SPILL_MAX_FILE_BYTES, `disk file exceeded 2 MiB: ${diskBytes}`);

      // 2. Deterministic rotation with >20 files, identical mtimeMs, unrelated file, and symlink
      const rotCache = path.join(rootDir, "rot-cache");
      const rotSpills = path.join(rotCache, "spills");
      await fsp.mkdir(rotSpills, { recursive: true, mode: 0o700 });

      const fixedNow = 1_750_000_000_000;
      const fixedDate = new Date(fixedNow);
      const createdNames: string[] = [];
      for (let i = 0; i < 25; i++) {
        // Deliberately higher timestamps than the incoming file so filename-descending alone would evict the incoming file unless pinned!
        const name = `spill-${9_000_000_000_000 + i}-run_checks-${String(i).padStart(12, "0")}.txt`;
        const full = path.join(rotSpills, name);
        await fsp.writeFile(full, `old-${i}\n`, { mode: 0o600 });
        fs.utimesSync(full, fixedDate, fixedDate);
        createdNames.push(name);
      }

      // Unrelated file + symlink with spill-like name must NEVER be touched by rotation
      const unrelated = path.join(rotSpills, "notes.txt");
      await fsp.writeFile(unrelated, "keep me\n", "utf8");
      const symTarget = path.join(rootDir, "sym-target.txt");
      await fsp.writeFile(symTarget, "do not unlink target\n", "utf8");
      const symEntry = path.join(rotSpills, "spill-1000000000000-run_checks-deadbeefcafe.txt");
      let hasSymEntry = false;
      try {
        await fsp.symlink(symTarget, symEntry);
        hasSymEntry = true;
      } catch {
        hasSymEntry = false;
      }

      // Write a new spill file with an EARLIER filename timestamp, then re-run rotation with identical mtimeMs
      const fresh = writeSpillFile({
        tool: "run_checks",
        rawContent: "just-written-payload\n",
        env: { AGY_FAST_CACHE_DIR: rotCache },
        nowMs: fixedNow,
      });
      assert.ok(fresh);
      // Force identical mtimeMs on the freshly written file and re-run rotation to stress same-ms tie-breaking
      fs.utimesSync(fresh.filePath, fixedDate, fixedDate);
      rotateSpillFiles(rotSpills, fresh.fileName, fixedNow);

      const remainingRegular = (await fsp.readdir(rotSpills)).filter((name) => {
        if (!SPILL_FILENAME_RE.test(name)) return false;
        const st = fs.lstatSync(path.join(rotSpills, name));
        return !st.isSymbolicLink() && st.isFile();
      });
      assert.equal(remainingRegular.length, SPILL_MAX_FILES);
      assert.ok(
        remainingRegular.includes(fresh.fileName),
        "Rotation must NEVER delete the just-written spill file even on same-ms tie with smaller filename",
      );
      // Deterministic tie-break keeps the 19 lexicographically highest older filenames (indices 6..24)
      for (let i = 6; i < 25; i++) {
        assert.ok(remainingRegular.includes(createdNames[i]!), `Expected ${createdNames[i]} kept`);
      }
      for (let i = 0; i < 6; i++) {
        assert.equal(remainingRegular.includes(createdNames[i]!), false, `Expected ${createdNames[i]} evicted`);
      }
      assert.equal(fs.existsSync(unrelated), true);
      if (hasSymEntry) {
        assert.equal(fs.lstatSync(symEntry).isSymbolicLink(), true);
        assert.equal(fs.existsSync(symTarget), true);
      }

      // 3. 24h TTL pruning
      const ttlCache = path.join(rootDir, "ttl-cache");
      const ttlSpills = path.join(ttlCache, "spills");
      await fsp.mkdir(ttlSpills, { recursive: true, mode: 0o700 });
      const expiredTime = new Date(fixedNow - SPILL_TTL_MS - 60_000);
      const validTime = new Date(fixedNow - SPILL_TTL_MS + 600_000);
      const expiredFile = path.join(ttlSpills, "spill-1700000000001-batch_search-111111111111.txt");
      const validFile = path.join(ttlSpills, "spill-1700000000002-batch_search-222222222222.txt");
      await fsp.writeFile(expiredFile, "expired\n", { mode: 0o600 });
      await fsp.writeFile(validFile, "still-valid\n", { mode: 0o600 });
      fs.utimesSync(expiredFile, expiredTime, expiredTime);
      fs.utimesSync(validFile, validTime, validTime);

      const ttlNew = writeSpillFile({
        tool: "batch_search",
        rawContent: "fresh-ttl\n",
        env: { AGY_FAST_CACHE_DIR: ttlCache },
        nowMs: fixedNow,
      });
      assert.ok(ttlNew);
      assert.equal(fs.existsSync(expiredFile), false, "Expired >24h spill file must be pruned");
      assert.equal(fs.existsSync(validFile), true, "Recent <24h spill file must survive");
      assert.equal(fs.existsSync(ttlNew.filePath), true);
    });
  });

  it("keeps low-level truncators and SessionStart 100% pure (zero spill side effects)", async () => {
    await withIsolatedSpillEnv(async ({ rootDir, cacheDir }) => {
      const huge = "line_data_".repeat(3000);
      const t1 = truncateWithByteNotice(huge, 1000);
      const t2 = truncateHeadTailWithByteNotice(huge, 1000);
      assert.ok(Buffer.byteLength(t1, "utf8") <= 1000);
      assert.ok(Buffer.byteLength(t2, "utf8") <= 1000);
      assert.equal(extractSpillPath(t1), null);
      assert.equal(extractSpillPath(t2), null);
      assert.equal(fs.existsSync(path.join(cacheDir, "spills")), false);

      // Run bundled dist/session-start.mjs directly and assert it never creates a spills dir or writes spill files
      const sessionStartEntry = path.resolve("dist", "session-start.mjs");
      const projDir = path.join(rootDir, "proj");
      await fsp.mkdir(projDir, { recursive: true });
      await fsp.writeFile(path.join(projDir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
      const ss = spawnSync(process.execPath, [sessionStartEntry], {
        input: JSON.stringify({ cwd: projDir, hookEventName: "SessionStart" }),
        encoding: "utf8",
        env: {
          ...process.env,
          AGY_FAST_CACHE_DIR: cacheDir,
          AGY_FAST_AUTO_UPDATE: "off",
        },
        timeout: 10_000,
      });
      assert.equal(ss.status, 0, ss.stderr);
      assert.equal(fs.existsSync(path.join(cacheDir, "spills")), false);
      assert.deepEqual(await listSpillFiles(cacheDir), []);
    });
  });
});
