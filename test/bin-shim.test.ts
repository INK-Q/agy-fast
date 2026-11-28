import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const INSTALL_SCRIPT = path.resolve(process.cwd(), "scripts", "install.mjs");
const IS_WIN = process.platform === "win32";
const SHELL_RC_FILES = [
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
];

function shimFileName(base: string): string {
  return IS_WIN ? `${base}.cmd` : base;
}

function makeIsolatedEnv(
  homeDir: string,
  extraPathEntries: string[] = [],
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const systemDirs = IS_WIN
    ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32"]
    : ["/usr/bin", "/bin"];
  const pathParts = [...extraPathEntries, nodeDir, ...systemDirs].filter(Boolean);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: pathParts.join(path.delimiter),
  };
  delete env.GEMINI_HOME;
  delete env.ANTIGRAVITY_APP_DATA_DIR;
  delete env.AGY_FAST_TOOLS;
  if (IS_WIN) {
    delete env.Path;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runInstaller(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runShimCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(command, args, {
    env,
    encoding: "utf8",
    shell: IS_WIN,
    windowsHide: true,
  });
  if (res.error) {
    throw res.error;
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("installer --bin-shim", () => {
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-bin-shim-"));
  });

  after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("installs shims into ~/.local/bin when on PATH and executes agy-fast & agy-fast-mcp cleanly", async () => {
    const home = path.join(tmpRoot, "case-default-home");
    const localBin = path.join(home, ".local", "bin");
    const pluginDir = path.join(tmpRoot, "case-default-plugin");
    await fs.mkdir(localBin, { recursive: true });

    const env = makeIsolatedEnv(home, [localBin]);
    const out = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--bin-shim", "--no-enable"],
      { env, encoding: "utf8" },
    );

    assert.match(out, /Installed bin shim\(s\) in .*\.local[\\/]+bin: agy-fast(?:\.cmd)?, agy-fast-mcp(?:\.cmd)?/);
    assert.match(out, /Bin shims\s+: OK \(agy-fast(?:\.cmd)?, agy-fast-mcp(?:\.cmd)? in /);

    const cliShim = path.join(localBin, shimFileName("agy-fast"));
    const mcpShim = path.join(localBin, shimFileName("agy-fast-mcp"));

    if (IS_WIN) {
      const cliBody = await fs.readFile(cliShim, "utf8");
      const mcpBody = await fs.readFile(mcpShim, "utf8");
      assert.match(cliBody, /@rem agy-fast-bin-shim/);
      assert.match(cliBody, /@node ".*scripts\\install\.mjs" %\*/);
      assert.match(mcpBody, /@rem agy-fast-bin-shim/);
      assert.match(mcpBody, /@node ".*dist\\mcp-server\.mjs" %\*/);
    } else {
      const cliStat = await fs.lstat(cliShim);
      const mcpStat = await fs.lstat(mcpShim);
      assert.ok(cliStat.isSymbolicLink(), "agy-fast shim should be a symlink on POSIX");
      assert.ok(mcpStat.isSymbolicLink(), "agy-fast-mcp shim should be a symlink on POSIX");
      assert.equal(
        await fs.realpath(cliShim),
        await fs.realpath(path.join(pluginDir, "scripts", "install.mjs")),
      );
      assert.equal(
        await fs.realpath(mcpShim),
        await fs.realpath(path.join(pluginDir, "dist", "mcp-server.mjs")),
      );
      assert.notEqual((await fs.stat(cliShim)).mode & 0o111, 0);
      assert.notEqual((await fs.stat(mcpShim)).mode & 0o111, 0);
    }

    const helpRes = runShimCommand("agy-fast", ["--help"], env);
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /agy-fast installer/);
    assert.match(helpRes.stdout, /--bin-shim/);

    const mcpHelpRes = runShimCommand("agy-fast-mcp", ["--cli", "--help"], env);
    assert.equal(mcpHelpRes.status, 0, mcpHelpRes.stderr);
    assert.match(mcpHelpRes.stdout, /agy-fast direct CLI mode/);

    const forwardedMcpHelp = runShimCommand("agy-fast", ["mcp", "--cli", "--help"], env);
    assert.equal(forwardedMcpHelp.status, 0, forwardedMcpHelp.stderr);
    assert.match(forwardedMcpHelp.stdout, /agy-fast direct CLI mode/);
  });

  it("supports --bin-shim-dir (creating directory, noting non-PATH, and idempotent re-run)", async () => {
    const home = path.join(tmpRoot, "case-custom-dir-home");
    const customBin = path.join(tmpRoot, "custom bin dir", "nested");
    const pluginDir1 = path.join(tmpRoot, "case-custom-plugin-1");
    const pluginDir2 = path.join(tmpRoot, "case-custom-plugin-2");
    await fs.mkdir(home, { recursive: true });

    const env = makeIsolatedEnv(home);
    const out1 = execFileSync(
      process.execPath,
      [
        INSTALL_SCRIPT,
        "install",
        "--target",
        pluginDir1,
        "--bin-shim-dir",
        customBin,
        "--no-enable",
      ],
      { env, encoding: "utf8" },
    );
    assert.match(out1, /Installed bin shim\(s\) in /);
    assert.match(out1, /is not currently on PATH/);
    assert.match(out1, /Bin shims\s+: OK /);

    // Idempotent re-run against the same plugin target
    const out2 = execFileSync(
      process.execPath,
      [
        INSTALL_SCRIPT,
        "install",
        "--target",
        pluginDir1,
        `--bin-shim-dir=${customBin}`,
        "--no-enable",
      ],
      { env, encoding: "utf8" },
    );
    assert.match(out2, /Bin shims\s+: OK /);

    // Re-pointing owned shims to a new plugin installation succeeds
    execFileSync(
      process.execPath,
      [
        INSTALL_SCRIPT,
        "install",
        "--target",
        pluginDir2,
        "--bin-shim-dir",
        customBin,
        "--no-enable",
      ],
      { env, encoding: "utf8" },
    );
    const cliShim = path.join(customBin, shimFileName("agy-fast"));
    if (!IS_WIN) {
      assert.equal(
        await fs.realpath(cliShim),
        await fs.realpath(path.join(pluginDir2, "scripts", "install.mjs")),
      );
    } else {
      const body = await fs.readFile(cliShim, "utf8");
      assert.ok(body.includes(path.join(pluginDir2, "scripts", "install.mjs")));
    }

    const res = runShimCommand(cliShim, ["--help"], env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /agy-fast installer/);
  });

  it("prints a non-fatal actionable hint without modifying shell rc files when no user PATH bin dir exists", async () => {
    const homeMissing = path.join(tmpRoot, "case-no-local-bin");
    const homeNotOnPath = path.join(tmpRoot, "case-not-on-path");
    const pluginDir = path.join(tmpRoot, "case-no-path-plugin");
    await fs.mkdir(homeMissing, { recursive: true });
    await fs.mkdir(path.join(homeNotOnPath, ".local", "bin"), { recursive: true });

    const outMissing = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--bin-shim", "--no-enable"],
      { env: makeIsolatedEnv(homeMissing), encoding: "utf8" },
    );
    assert.match(outMissing, /skipped --bin-shim/i);
    assert.match(outMissing, /--bin-shim-dir/);
    assert.match(outMissing, /Installation complete/);

    const outNotOnPath = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--bin-shim", "--no-enable"],
      { env: makeIsolatedEnv(homeNotOnPath), encoding: "utf8" },
    );
    assert.match(outNotOnPath, /is not on PATH/);
    assert.match(outNotOnPath, /--bin-shim-dir/);
    assert.match(outNotOnPath, /Installation complete/);

    for (const h of [homeMissing, homeNotOnPath]) {
      for (const rc of SHELL_RC_FILES) {
        await assert.rejects(fs.lstat(path.join(h, rc)), `Must never create ${rc}`);
      }
    }

    // Expands ~/ entries in PATH (including trailing separator) cleanly
    const tildeEnv = makeIsolatedEnv(homeNotOnPath, ["~/.local/bin/"]);
    const outTilde = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--bin-shim", "--no-enable"],
      { env: tildeEnv, encoding: "utf8" },
    );
    assert.match(outTilde, /Installed bin shim\(s\) in /);
    assert.match(outTilde, /Bin shims\s+: OK /);
  });

  it("supports --link dev mode and skips global --bin-shim on --project unless --bin-shim-dir is given", async () => {
    const home = path.join(tmpRoot, "case-link-proj-home");
    const localBin = path.join(home, ".local", "bin");
    const linkTarget = path.join(tmpRoot, "case-linked-plugin");
    const projDir = path.join(tmpRoot, "case-project-repo");
    const projBin = path.join(tmpRoot, "case-project-bin");
    await fs.mkdir(localBin, { recursive: true });
    await fs.mkdir(projDir, { recursive: true });

    const env = makeIsolatedEnv(home, [localBin]);

    // 1. --project with --bin-shim (no --bin-shim-dir) skips installing into ~/.local/bin
    const projSkipOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--project", projDir, "--bin-shim", "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(projSkipOut, /skipped --bin-shim for --project/i);
    await assert.rejects(fs.lstat(path.join(localBin, shimFileName("agy-fast"))));

    // 2. --project with explicit --bin-shim-dir installs shims into custom dir
    const projExplicitOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--project", projDir, "--bin-shim-dir", projBin, "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(projExplicitOut, /Installed bin shim\(s\) in /);

    // 3. --link mode works with --bin-shim and cleans up cleanly on uninstall
    const linkOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", linkTarget, "--link", "--bin-shim", "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(linkOut, /Linked /);
    assert.match(linkOut, /Installed bin shim\(s\) in /);

    const helpRes = runShimCommand("agy-fast", ["--help"], env);
    assert.equal(helpRes.status, 0, helpRes.stderr);

    const rmOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "uninstall", "--target", linkTarget, "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(rmOut, /Removed bin shim\(s\) from /);
    await assert.rejects(fs.lstat(path.join(localBin, shimFileName("agy-fast"))));
    await assert.rejects(fs.lstat(path.join(localBin, shimFileName("agy-fast-mcp"))));
  });

  it("protects pre-existing unrelated files and symlinks from overwriting", async () => {
    const home = path.join(tmpRoot, "case-collision-home");
    const binDir = path.join(tmpRoot, "case-collision-bin");
    const pluginDir = path.join(tmpRoot, "case-collision-plugin");
    const unrelatedDir = path.join(tmpRoot, "unrelated-tool");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(unrelatedDir, "scripts"), { recursive: true });

    const foreignCli = path.join(binDir, shimFileName("agy-fast"));
    const originalContent = IS_WIN ? "@echo FOREIGN_CLI\r\n" : "#!/bin/sh\necho FOREIGN_CLI\n";
    await fs.writeFile(foreignCli, originalContent, "utf8");
    if (!IS_WIN) {
      await fs.chmod(foreignCli, 0o755);
    }

    const foreignMcp = path.join(binDir, shimFileName("agy-fast-mcp"));
    const unrelatedScript = path.join(unrelatedDir, "scripts", "install.mjs");
    await fs.writeFile(unrelatedScript, "// unrelated tool\n", "utf8");
    if (!IS_WIN) {
      await fs.symlink(unrelatedScript, foreignMcp);
    } else {
      await fs.writeFile(foreignMcp, "@echo FOREIGN_MCP\r\n", "utf8");
    }

    const env = makeIsolatedEnv(home, [binDir]);
    const res = runInstaller(
      ["install", "--target", pluginDir, "--bin-shim-dir", binDir, "--no-enable"],
      env,
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /Warning: skipped bin shim .*agy-fast/);
    assert.match(res.stderr, /Warning: skipped bin shim .*agy-fast-mcp/);
    assert.equal(await fs.readFile(foreignCli, "utf8"), originalContent);
    if (!IS_WIN) {
      assert.equal(await fs.readlink(foreignMcp), unrelatedScript);
    }

    // Partial collision: remove foreign agy-fast-mcp and verify it gets installed while foreign agy-fast stays untouched
    await fs.unlink(foreignMcp);
    const partialRes = runInstaller(
      ["install", "--target", pluginDir, "--bin-shim-dir", binDir, "--no-enable"],
      env,
    );
    assert.equal(partialRes.status, 0, partialRes.stderr);
    assert.match(partialRes.stderr, /Warning: skipped bin shim .*agy-fast/);
    assert.match(partialRes.stdout, /Installed bin shim\(s\) in .*agy-fast-mcp/);
    assert.equal(await fs.readFile(foreignCli, "utf8"), originalContent);
    assert.ok(await fs.lstat(foreignMcp));
  });

  it("reports status/doctor cleanly when absent, present, wrapper-backed, or broken", async () => {
    const home = path.join(tmpRoot, "case-doctor-home");
    const localBin = path.join(home, ".local", "bin");
    const pluginDir = path.join(tmpRoot, "case-doctor-plugin");
    const wrapperBin = path.join(tmpRoot, "case-doctor-wrapper-bin");
    await fs.mkdir(localBin, { recursive: true });
    await fs.mkdir(wrapperBin, { recursive: true });

    const env = makeIsolatedEnv(home, [localBin]);

    // Absent shims must never fail doctor
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--no-enable"],
      { env, encoding: "utf8" },
    );
    const cleanDoc = runInstaller(["doctor", "--target", pluginDir], env);
    assert.equal(cleanDoc.status, 0, cleanDoc.stderr);
    assert.doesNotMatch(cleanDoc.stdout, /Bin shims\s+:/);

    // Explicit --bin-shim-dir with no shims reports none and passes
    const emptyDirDoc = runInstaller(
      ["doctor", "--target", pluginDir, "--bin-shim-dir", wrapperBin],
      env,
    );
    assert.equal(emptyDirDoc.status, 0, emptyDirDoc.stderr);
    assert.match(emptyDirDoc.stdout, /Bin shims\s+: none in /);

    // Installed shims report OK
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginDir, "--bin-shim", "--no-enable"],
      { env, encoding: "utf8" },
    );
    const okDoc = runInstaller(["status", "--target", pluginDir], env);
    assert.equal(okDoc.status, 0, okDoc.stderr);
    assert.match(okDoc.stdout, /Bin shims\s+: OK \(agy-fast(?:\.cmd)?, agy-fast-mcp(?:\.cmd)? in /);

    // POSIX fallback wrapper with marker is also recognized cleanly
    if (!IS_WIN) {
      const wrapperCli = path.join(wrapperBin, "agy-fast");
      const targetCli = path.join(pluginDir, "scripts", "install.mjs");
      await fs.writeFile(
        wrapperCli,
        `#!/usr/bin/env sh\n# agy-fast-bin-shim\n# agy-fast-target: ${JSON.stringify(targetCli)}\nexec node '${targetCli}' "$@"\n`,
        "utf8",
      );
      await fs.chmod(wrapperCli, 0o755);
      const wrapDoc = runInstaller(
        ["doctor", "--target", pluginDir, "--bin-shim-dir", wrapperBin],
        env,
      );
      assert.equal(wrapDoc.status, 0, wrapDoc.stderr);
      assert.match(wrapDoc.stdout, /Bin shims\s+: OK \(agy-fast in /);
    }

    // Broken / dangling agy-fast shim reports BROKEN and fails doctor
    const brokenShim = path.join(localBin, shimFileName("agy-fast"));
    await fs.unlink(brokenShim);
    const deletedPlugin = path.join(tmpRoot, "deleted-old-plugin");
    if (IS_WIN) {
      await fs.writeFile(
        brokenShim,
        `@rem agy-fast-bin-shim\r\n@node "${path.join(deletedPlugin, "scripts", "install.mjs")}" %*\r\n`,
        "utf8",
      );
    } else {
      await fs.symlink(path.join(deletedPlugin, "scripts", "install.mjs"), brokenShim);
    }

    const brokenDoc = runInstaller(["doctor", "--target", pluginDir], env);
    assert.notEqual(brokenDoc.status, 0);
    assert.match(brokenDoc.stdout, /Bin shims\s+: BROKEN \(agy-fast(?:\.cmd)? in /);
  });

  it("uninstalls only shims pointing to the uninstalled targetDir and leaves others untouched", async () => {
    const home = path.join(tmpRoot, "case-uninstall-home");
    const binDir = path.join(tmpRoot, "case-uninstall-bin");
    const pluginA = path.join(tmpRoot, "case-uninstall-plugin-a");
    const pluginB = path.join(tmpRoot, "case-uninstall-plugin-b");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    const env = makeIsolatedEnv(home, [binDir]);
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginA, "--bin-shim-dir", binDir, "--no-enable"],
      { env, encoding: "utf8" },
    );
    // Point agy-fast-mcp to pluginB while keeping agy-fast pointing to pluginA
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "install", "--target", pluginB, "--no-enable"],
      { env, encoding: "utf8" },
    );
    const mcpShim = path.join(binDir, shimFileName("agy-fast-mcp"));
    await fs.unlink(mcpShim);
    const pluginBMcpTarget = path.join(pluginB, "dist", "mcp-server.mjs");
    if (IS_WIN) {
      await fs.writeFile(
        mcpShim,
        `@rem agy-fast-bin-shim\r\n@node "${pluginBMcpTarget}" %*\r\n`,
        "utf8",
      );
    } else {
      await fs.symlink(pluginBMcpTarget, mcpShim);
    }

    // Place an unrelated file in the same bin directory to ensure uninstall never touches it
    const unrelated = path.join(binDir, "other-cli");
    await fs.writeFile(unrelated, "unrelated", "utf8");

    const rmA = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "uninstall", "--target", pluginA, "--bin-shim-dir", binDir, "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(rmA, /Removed agy-fast from /);
    assert.match(rmA, /Removed bin shim\(s\) from .*agy-fast(?:\.cmd)?$/m);

    // pluginA's agy-fast shim was removed, while pluginB's agy-fast-mcp shim & unrelated file survived
    await assert.rejects(fs.lstat(path.join(binDir, shimFileName("agy-fast"))));
    assert.ok(await fs.lstat(mcpShim));
    assert.equal(await fs.readFile(unrelated, "utf8"), "unrelated");

    // Also cleans up dangling shims pointing to an already-deleted pluginDir
    await fs.rm(pluginB, { recursive: true, force: true });
    const rmDangling = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "uninstall", "--target", pluginB, "--bin-shim-dir", binDir, "--no-enable"],
      { env, encoding: "utf8" },
    );
    assert.match(rmDangling, /Removed bin shim\(s\) from .*agy-fast-mcp(?:\.cmd)?/);
    await assert.rejects(fs.lstat(mcpShim));
  });

  it("validates --bin-shim-dir and rejects unsupported command combinations", async () => {
    const home = path.join(tmpRoot, "case-validate-home");
    await fs.mkdir(home, { recursive: true });
    const env = makeIsolatedEnv(home);

    for (const args of [
      ["install", "--bin-shim-dir"],
      ["install", "--bin-shim-dir", "--no-enable"],
      ["install", "--bin-shim-dir="],
    ]) {
      const res = runInstaller(args, env);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /Missing directory path after --bin-shim-dir/);
    }

    for (const cmd of ["config", "mcp-config"]) {
      const res = runInstaller([cmd, "--bin-shim"], env);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /only supported with install, update, status, doctor, and uninstall/);
    }
  });
});
