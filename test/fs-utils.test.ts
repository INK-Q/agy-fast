import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { walkFiles } from "../src/utils/fs-utils.js";

type ReaddirFn = (...args: unknown[]) => Promise<unknown>;

function instrumentReaddir(
  hook?: (dirPath: string) => number | Promise<void> | void,
): {
  getCalls: () => number;
  getVisitedPaths: () => string[];
  getInFlight: () => number;
  getMaxInFlight: () => number;
  reset: () => void;
  restore: () => void;
} {
  const origReaddir = fs.readdir as ReaddirFn;
  let calls = 0;
  let visitedPaths: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  (fs as unknown as { readdir: ReaddirFn }).readdir = async (...args: unknown[]) => {
    const dirPath = String(args[0]);
    calls++;
    visitedPaths.push(dirPath);
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      if (hook) {
        const res = hook(dirPath);
        if (typeof res === "number" && res > 0) {
          await new Promise((r) => setTimeout(r, res));
        } else if (res && typeof (res as Promise<void>).then === "function") {
          await res;
        }
      }
      return await origReaddir(...args);
    } finally {
      inFlight--;
    }
  };

  return {
    getCalls: () => calls,
    getVisitedPaths: () => visitedPaths,
    getInFlight: () => inFlight,
    getMaxInFlight: () => maxInFlight,
    reset: () => {
      calls = 0;
      visitedPaths = [];
      maxInFlight = 0;
    },
    restore: () => {
      (fs as unknown as { readdir: ReaddirFn }).readdir = origReaddir;
    },
  };
}

describe("walkFiles budget & concurrency invariants", () => {
  it("preserves files from scanned sibling directories when maxDirs is hit in a sibling batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-maxdirs-"));
    try {
      for (let i = 0; i < 8; i++) {
        const sub = path.join(root, `d${i}`);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "z.ts"), `export const z = ${i};\n`, "utf8");
        await fs.writeFile(path.join(sub, "a.ts"), `export const a = ${i};\n`, "utf8");
      }

      const spy = instrumentReaddir();
      try {
        // Root counts as dir #1; d0..d3 are dirs #2..#5; d4 exceeds maxDirs: 5.
        const res = await walkFiles(root, { maxDirs: 5 });
        assert.deepEqual(res.files, [
          "d0/a.ts",
          "d0/z.ts",
          "d1/a.ts",
          "d1/z.ts",
          "d2/a.ts",
          "d2/z.ts",
          "d3/a.ts",
          "d3/z.ts",
        ]);
        assert.equal(res.truncated, true);
        assert.equal(res.dirsTruncated, true);
        assert.equal(res.timedOut, undefined);
        assert.equal(spy.getCalls(), 5);
        assert.equal(spy.getInFlight(), 0);
      } finally {
        spy.restore();
      }

      // Larger flat tree where concurrent sibling prefetch (batchSize > 1) is active
      // before tapering down to the exact maxDirs boundary.
      const wideRoot = path.join(root, "wide");
      for (let i = 0; i < 90; i++) {
        const sub = path.join(wideRoot, `d${String(i).padStart(2, "0")}`);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "f.ts"), `export const n = ${i};\n`, "utf8");
      }

      const wideSpy = instrumentReaddir(() => 2);
      try {
        const res = await walkFiles(wideRoot, { maxDirs: 70 });
        const expected = Array.from(
          { length: 69 },
          (_, i) => `d${String(i).padStart(2, "0")}/f.ts`,
        );
        assert.deepEqual(res.files, expected);
        assert.equal(res.truncated, true);
        assert.equal(res.dirsTruncated, true);
        assert.equal(wideSpy.getCalls(), 70);
        assert.ok(
          wideSpy.getMaxInFlight() > 1 && wideSpy.getMaxInFlight() <= 16,
          `Expected concurrent prefetching in (1, 16], got ${wideSpy.getMaxInFlight()}`,
        );
        assert.equal(wideSpy.getInFlight(), 0);
      } finally {
        wideSpy.restore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles exact maxDirs boundaries without false truncation across flat, nested, and maxDepth trees", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-exactdirs-"));
    try {
      await fs.writeFile(path.join(root, "root.ts"), "export const r = 0;\n", "utf8");
      for (const name of ["c", "a", "b"]) {
        const sub = path.join(root, name);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, `${name}.ts`), `export const ${name} = 1;\n`, "utf8");
      }
      // Ignored and hidden directories must not consume maxDirs quota
      await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(root, "node_modules", "pkg", "x.ts"), "x\n", "utf8");
      await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
      await fs.writeFile(path.join(root, ".hidden", "h.ts"), "h\n", "utf8");

      // Exact fit: root + a + b + c = 4 directories
      const exact = await walkFiles(root, { maxDirs: 4 });
      assert.deepEqual(exact.files, ["root.ts", "a/a.ts", "b/b.ts", "c/c.ts"]);
      assert.equal(exact.truncated, false);
      assert.equal(exact.dirsTruncated, undefined);

      // One fewer: root + a + b = 3 directories; c is skipped
      const under = await walkFiles(root, { maxDirs: 3 });
      assert.deepEqual(under.files, ["root.ts", "a/a.ts", "b/b.ts"]);
      assert.equal(under.truncated, true);
      assert.equal(under.dirsTruncated, true);

      // maxDirs: 1 with maxDepth: 0 -> only root is reachable -> NOT truncated
      const depthZero = await walkFiles(root, { maxDirs: 1, maxDepth: 0 });
      assert.deepEqual(depthZero.files, ["root.ts"]);
      assert.equal(depthZero.truncated, false);
      assert.equal(depthZero.dirsTruncated, undefined);

      // maxDirs: 1 with reachable subdirs -> root file preserved, dirsTruncated: true
      const rootOnlyCap = await walkFiles(root, { maxDirs: 1 });
      assert.deepEqual(rootOnlyCap.files, ["root.ts"]);
      assert.equal(rootOnlyCap.truncated, true);
      assert.equal(rootOnlyCap.dirsTruncated, true);

      // Leaf root (0 subdirs) with maxDirs: 1 -> NOT truncated
      const leafRoot = path.join(root, "a");
      const leafExact = await walkFiles(leafRoot, { maxDirs: 1 });
      assert.deepEqual(leafExact.files, ["a.ts"]);
      assert.equal(leafExact.truncated, false);
      assert.equal(leafExact.dirsTruncated, undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("maintains strict deterministic lexicographical DFS order and bounded visitedDirs on nested trees with tight and large maxDirs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-nested-"));
    try {
      // Tree with deep first branch + 7 sibling dirs:
      // root (#1) -> d0 (#2) -> d0/sub (#3) -> d0/sub/deeper (#4) -> d1 (#5) -> d2 (#6) ...
      await fs.mkdir(path.join(root, "d0", "sub", "deeper"), { recursive: true });
      await fs.writeFile(path.join(root, "d0", "a.ts"), "1\n", "utf8");
      await fs.writeFile(path.join(root, "d0", "sub", "deep.ts"), "2\n", "utf8");
      await fs.writeFile(path.join(root, "d0", "sub", "deeper", "leaf.ts"), "3\n", "utf8");
      for (let i = 1; i < 8; i++) {
        const sub = path.join(root, `d${i}`);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "f.ts"), `${i}\n`, "utf8");
      }

      const spy = instrumentReaddir();
      try {
        const cap3 = await walkFiles(root, { maxDirs: 3 });
        assert.deepEqual(cap3.files, ["d0/a.ts", "d0/sub/deep.ts"]);
        assert.equal(cap3.truncated, true);
        assert.equal(cap3.dirsTruncated, true);
        assert.equal(spy.getCalls(), 3);
        assert.equal(spy.getInFlight(), 0);

        spy.reset();
        const cap5 = await walkFiles(root, { maxDirs: 5 });
        assert.deepEqual(cap5.files, [
          "d0/a.ts",
          "d0/sub/deep.ts",
          "d0/sub/deeper/leaf.ts",
          "d1/f.ts",
        ]);
        assert.equal(cap5.truncated, true);
        assert.equal(cap5.dirsTruncated, true);
        assert.equal(spy.getCalls(), 5);
        assert.equal(spy.getInFlight(), 0);
      } finally {
        spy.restore();
      }

      // Larger multi-level tree (100 dirs total) exercising concurrent sibling
      // prefetching at root while d0 has a large nested subtree.
      const bigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-bignested-"));
      try {
        // 1 (bigRoot) + 1 (d0) + 90 (d0/s00..s89) + 8 (d1..d8) = 100 dirs
        await fs.mkdir(path.join(bigRoot, "d0"), { recursive: true });
        await fs.writeFile(path.join(bigRoot, "d0", "top.ts"), "0\n", "utf8");
        for (let i = 0; i < 90; i++) {
          const sub = path.join(bigRoot, "d0", `s${String(i).padStart(2, "0")}`);
          await fs.mkdir(sub, { recursive: true });
          await fs.writeFile(path.join(sub, "item.ts"), `${i}\n`, "utf8");
        }
        for (let i = 1; i <= 8; i++) {
          const sub = path.join(bigRoot, `d${i}`);
          await fs.mkdir(sub, { recursive: true });
          await fs.writeFile(path.join(sub, "sib.ts"), `${i}\n`, "utf8");
        }

        const full = await walkFiles(bigRoot);
        assert.equal(full.truncated, false);
        assert.equal(full.files.length, 99);

        // Exact 100-dir boundary succeeds with zero false truncation even with prefetching
        const exact100 = await walkFiles(bigRoot, { maxDirs: 100 });
        assert.deepEqual(exact100.files, full.files);
        assert.equal(exact100.truncated, false);
        assert.equal(exact100.dirsTruncated, undefined);

        // Tight cap inside concurrent prefetch zone must stay a contiguous DFS prefix
        // with zero DFS holes (never skipping d0/s* while emitting d1..d8).
        const bigSpy = instrumentReaddir();
        try {
          const cap70 = await walkFiles(bigRoot, { maxDirs: 70 });
          assert.equal(cap70.truncated, true);
          assert.equal(cap70.dirsTruncated, true);
          assert.ok(bigSpy.getCalls() <= 70, `Expected <= 70 readdir calls, got ${bigSpy.getCalls()}`);
          assert.equal(bigSpy.getInFlight(), 0);
          assert.ok(cap70.files.length >= 60, `Expected >= 60 files preserved, got ${cap70.files.length}`);
          assert.deepEqual(
            cap70.files,
            full.files.slice(0, cap70.files.length),
            "Truncated result must remain an exact contiguous lexicographical DFS prefix",
          );
        } finally {
          bigSpy.restore();
        }
      } finally {
        await fs.rm(bigRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves already-scanned files when timeoutMs fires mid-batch without exceeding maxFiles or leaving in-flight readdirs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-timeout-"));
    try {
      for (let i = 0; i < 16; i++) {
        const sub = path.join(root, `d${String(i).padStart(2, "0")}`);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "f1.ts"), "1\n", "utf8");
        await fs.writeFile(path.join(sub, "f2.ts"), "2\n", "utf8");
      }
      const full = await walkFiles(root);
      assert.equal(full.files.length, 32);

      // Batch 1 is d00..d07: d00..d03 resolve immediately, d04..d07 take 90ms
      // so timeoutMs: 25 fires mid-batch before batch 2 (d08..d15) can start.
      const spy = instrumentReaddir((dirPath) => {
        const base = path.basename(dirPath);
        if (/^d0[4-7]$/.test(base)) return 90;
        return 0;
      });
      try {
        const res = await walkFiles(root, { timeoutMs: 25, maxFiles: 100 });
        assert.equal(res.timedOut, true);
        assert.equal(res.truncated, true);
        assert.equal(spy.getInFlight(), 0, "Must leave 0 in-flight fs.readdir calls after timeout");
        assert.ok(
          res.files.length >= 8,
          `Expected already-scanned batch-1 files preserved, got ${res.files.length}`,
        );
        assert.deepEqual(res.files, full.files.slice(0, res.files.length));
        const batch2Read = spy.getVisitedPaths().some((p) => /^d(?:0[89]|1\d)$/.test(path.basename(p)));
        assert.equal(batch2Read, false, "Batch 2 directories must not be read after timeout");
      } finally {
        spy.restore();
      }

      // Timeout firing while all batch-1 dirs are in flight must still preserve
      // already-scanned files without exceeding maxFiles and leave 0 in-flight calls.
      const slowBatchSpy = instrumentReaddir((dirPath) => {
        if (dirPath !== root) return 90;
        return 0;
      });
      try {
        const capped = await walkFiles(root, { timeoutMs: 25, maxFiles: 5 });
        assert.equal(capped.timedOut, true);
        assert.equal(capped.truncated, true);
        assert.equal(capped.files.length, 5);
        assert.deepEqual(capped.files, full.files.slice(0, 5));
        assert.equal(slowBatchSpy.getInFlight(), 0);
        const batch2Read = slowBatchSpy
          .getVisitedPaths()
          .some((p) => /^d(?:0[89]|1\d)$/.test(path.basename(p)));
        assert.equal(batch2Read, false, "Batch 2 directories must not be read after timeout");
      } finally {
        slowBatchSpy.restore();
      }

      // Timeout mid-batch on nested dirs must preserve already-scanned parent files
      // without creating DFS holes by skipping unscanned child subdirs.
      const nestedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-timeout-nested-"));
      try {
        await fs.mkdir(path.join(nestedRoot, "d0", "child"), { recursive: true });
        await fs.writeFile(path.join(nestedRoot, "d0", "parent.ts"), "1\n", "utf8");
        await fs.writeFile(path.join(nestedRoot, "d0", "child", "deep.ts"), "2\n", "utf8");
        for (let i = 1; i < 8; i++) {
          const sub = path.join(nestedRoot, `d${i}`);
          await fs.mkdir(sub, { recursive: true });
          await fs.writeFile(path.join(sub, "sib.ts"), `${i}\n`, "utf8");
        }

        const nestedSpy = instrumentReaddir((dirPath) => {
          if (dirPath !== nestedRoot) return 90;
          return 0;
        });
        try {
          const res = await walkFiles(nestedRoot, { timeoutMs: 25 });
          assert.equal(res.timedOut, true);
          assert.equal(res.truncated, true);
          assert.equal(nestedSpy.getInFlight(), 0);
          // d0/parent.ts was already scanned; d0/child cannot start after timeout,
          // so d1..d7 must NOT be emitted ahead of the skipped d0/child subtree.
          assert.deepEqual(res.files, ["d0/parent.ts"]);
          const childRead = nestedSpy.getVisitedPaths().some((p) => path.basename(p) === "child");
          assert.equal(childRead, false, "Unvisited child dir must not start after timeout");
        } finally {
          nestedSpy.restore();
        }
      } finally {
        await fs.rm(nestedRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces exact maxFiles boundaries, avoids false dirsTruncated when maxFiles stops first, and caps concurrent readdirs <= 16", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-maxfiles-"));
    try {
      await fs.mkdir(path.join(root, "d00"), { recursive: true });
      await fs.writeFile(path.join(root, "d00", "f1.ts"), "1\n", "utf8");
      await fs.writeFile(path.join(root, "d00", "f2.ts"), "2\n", "utf8");
      await fs.writeFile(path.join(root, "d00", "f3.ts"), "3\n", "utf8");
      for (let i = 1; i < 24; i++) {
        const sub = path.join(root, `d${String(i).padStart(2, "0")}`, "leaf");
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "a.ts"), "a\n", "utf8");
        await fs.writeFile(path.join(sub, "b.ts"), "b\n", "utf8");
      }

      const full = await walkFiles(root, { maxFiles: 100 });
      assert.equal(full.truncated, false);
      assert.equal(full.files.length, 49);

      // Exact maxFiles fit must NOT set truncated
      const exact = await walkFiles(root, { maxFiles: 49 });
      assert.equal(exact.truncated, false);
      assert.deepEqual(exact.files, full.files);

      // maxFiles = 48 overflows on the 49th file
      const over = await walkFiles(root, { maxFiles: 48 });
      assert.equal(over.truncated, true);
      assert.deepEqual(over.files, full.files.slice(0, 48));

      // maxFiles: 0 on non-empty vs empty directory
      const zeroNonEmpty = await walkFiles(root, { maxFiles: 0 });
      assert.equal(zeroNonEmpty.truncated, true);
      assert.deepEqual(zeroNonEmpty.files, []);

      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fsutils-empty-"));
      try {
        const zeroEmpty = await walkFiles(emptyDir, { maxFiles: 0 });
        assert.equal(zeroEmpty.truncated, false);
        assert.deepEqual(zeroEmpty.files, []);
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true });
      }

      // maxFiles stopping inside d00 must NOT falsely report dirsTruncated
      const filesBeforeDirs = await walkFiles(root, { maxFiles: 2, maxDirs: 5 });
      assert.deepEqual(filesBeforeDirs.files, ["d00/f1.ts", "d00/f2.ts"]);
      assert.equal(filesBeforeDirs.truncated, true);
      assert.equal(filesBeforeDirs.dirsTruncated, undefined);

      // Concurrency cap <= 16 and inFlight === 0 across full, maxFiles, and maxDirs truncations
      const spy = instrumentReaddir(() => 4);
      try {
        const fullRun = await walkFiles(root, { maxFiles: 100 });
        assert.equal(fullRun.truncated, false);
        assert.equal(fullRun.files.length, 49);
        assert.ok(spy.getMaxInFlight() <= 16, `Expected <=16 concurrent readdirs, got ${spy.getMaxInFlight()}`);
        assert.equal(spy.getInFlight(), 0);

        spy.reset();
        const fileTruncRun = await walkFiles(root, { maxFiles: 3 });
        assert.equal(fileTruncRun.truncated, true);
        assert.deepEqual(fileTruncRun.files, ["d00/f1.ts", "d00/f2.ts", "d00/f3.ts"]);
        assert.ok(spy.getMaxInFlight() <= 16);
        assert.equal(spy.getInFlight(), 0);

        spy.reset();
        const dirTruncRun = await walkFiles(root, { maxDirs: 10 });
        assert.equal(dirTruncRun.truncated, true);
        assert.equal(dirTruncRun.dirsTruncated, true);
        assert.equal(spy.getCalls(), 10);
        assert.ok(spy.getMaxInFlight() <= 16);
        assert.equal(spy.getInFlight(), 0);
        assert.deepEqual(dirTruncRun.files, full.files.slice(0, dirTruncRun.files.length));
      } finally {
        spy.restore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
