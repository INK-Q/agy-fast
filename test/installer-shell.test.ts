import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT_DIR = process.cwd();
const INSTALL_SH = path.resolve(ROOT_DIR, "install.sh");
const TEST_RUNNER_SCRIPT = path.resolve(ROOT_DIR, "scripts", "test.mjs");
const BUILD_SCRIPT = path.resolve(ROOT_DIR, "scripts", "build.mjs");
const STRESS_BENCHMARK_SCRIPT = path.resolve(ROOT_DIR, "scripts", "stress-benchmark.mjs");
const posixOnly = { skip: process.platform === "win32" };

interface InstallerFixture {
  tmp: string;
  project: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

async function withFixture(run: (fixture: InstallerFixture) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-shell-safety-"));
  try {
    const project = path.join(tmp, "workspace");
    const binDir = path.join(tmp, "bin");
    const repo = path.join(tmp, "local-plugin");
    const home = path.join(tmp, "home");
    await fs.mkdir(path.join(project, "scripts"), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.mkdir(home, { recursive: true });

    // Fail locally instead of contacting the network when the installer chooses remote mode.
    const fakeGit = path.join(binDir, "git");
    await fs.writeFile(fakeGit, "#!/bin/sh\necho REMOTE_CLONE_ATTEMPT >&2\nexit 19\n");
    await fs.chmod(fakeGit, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    delete env.AGY_FAST_REPO;
    await run({ tmp, project, repo, env });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("piped install never executes a workspace-local decoy installer", posixOnly, async () => {
  await withFixture(async ({ project, env }) => {
    await fs.writeFile(path.join(project, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(path.join(project, "scripts", "install.mjs"), 'console.log("DECOY_EXECUTED");\n');
    const source = await fs.readFile(INSTALL_SH, "utf8");
    const res = spawnSync("sh", ["-s"], {
      cwd: project,
      env,
      input: source,
      encoding: "utf8",
    });
    assert.equal(res.status, 19, res.stderr);
    assert.match(res.stderr, /REMOTE_CLONE_ATTEMPT/);
    assert.doesNotMatch(res.stdout, /DECOY_EXECUTED/);
  });
});

test("explicit local shell install resolves its own directory from another cwd", posixOnly, async () => {
  await withFixture(async ({ project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(
      path.join(repo, "scripts", "install.mjs"),
      'console.log("LOCAL_INSTALLER", process.argv.slice(2).join(" "));\n',
    );
    const absolutePath = path.join(repo, "install.sh");
    const res = spawnSync("sh", [absolutePath, "doctor"], { cwd: project, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /LOCAL_INSTALLER doctor/);
    assert.doesNotMatch(res.stderr, /REMOTE_CLONE_ATTEMPT/);
  });
});

test("explicit local shell install rejects another plugin's manifest", posixOnly, async () => {
  await withFixture(async ({ project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "different-plugin" }));
    await fs.writeFile(path.join(repo, "scripts", "install.mjs"), 'console.log("WRONG_PLUGIN_EXECUTED");\n');
    const res = spawnSync("sh", [path.join(repo, "install.sh")], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(res.status, 19, res.stderr);
    assert.match(res.stderr, /REMOTE_CLONE_ATTEMPT/);
    assert.doesNotMatch(res.stdout, /WRONG_PLUGIN_EXECUTED/);
  });
});

test("explicit and installed shell invocations forward mcp and mcp-config without injecting install", posixOnly, async () => {
  await withFixture(async ({ project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(
      path.join(repo, "scripts", "install.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );

    const localShell = path.join(repo, "install.sh");
    const mcpCfgRes = spawnSync("sh", [localShell, "mcp-config", "--host", "generic", "--quiet"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(mcpCfgRes.status, 0, mcpCfgRes.stderr);
    assert.deepEqual(JSON.parse(mcpCfgRes.stdout), ["mcp-config", "--host", "generic", "--quiet"]);

    const mcpRes = spawnSync("sh", [localShell, "mcp", "--schema-compat=minimal"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(mcpRes.status, 0, mcpRes.stderr);
    assert.deepEqual(JSON.parse(mcpRes.stdout), ["mcp", "--schema-compat=minimal"]);

    // Non-subcommand invocations must still default to `install`
    const flagRes = spawnSync("sh", [localShell, "--project", project], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(flagRes.status, 0, flagRes.stderr);
    assert.deepEqual(JSON.parse(flagRes.stdout), ["install", "--project", project]);

    // Installed target fallback when piped without a local checkout
    const installedScripts = path.join(env.HOME!, ".gemini", "config", "plugins", "agy-fast", "scripts");
    await fs.mkdir(installedScripts, { recursive: true });
    await fs.writeFile(
      path.join(installedScripts, "install.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const source = await fs.readFile(INSTALL_SH, "utf8");
    const pipedInstalledRes = spawnSync("sh", ["-s", "--", "mcp-config", "--quiet"], {
      cwd: project,
      env,
      input: source,
      encoding: "utf8",
    });
    assert.equal(pipedInstalledRes.status, 0, pipedInstalledRes.stderr);
    assert.deepEqual(JSON.parse(pipedInstalledRes.stdout), ["mcp-config", "--quiet"]);
    assert.doesNotMatch(pipedInstalledRes.stderr, /REMOTE_CLONE_ATTEMPT/);
  });
});

test("shell installer handles unset or empty HOME safely under set -eu", posixOnly, async () => {
  await withFixture(async ({ tmp, project, repo, env }) => {
    await fs.copyFile(INSTALL_SH, path.join(repo, "install.sh"));
    await fs.writeFile(path.join(repo, "plugin.json"), JSON.stringify({ name: "agy-fast" }));
    await fs.writeFile(
      path.join(repo, "scripts", "install.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );

    const noHomeEnv: NodeJS.ProcessEnv = { ...env };
    delete noHomeEnv.HOME;

    const helpRes = spawnSync("sh", [path.join(repo, "install.sh"), "--help"], {
      cwd: project,
      env: noHomeEnv,
      encoding: "utf8",
    });
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.deepEqual(JSON.parse(helpRes.stdout), ["--help"]);
    assert.doesNotMatch(helpRes.stderr, /unbound|not set/i);

    const customTarget = path.join(tmp, "custom-target");
    const emptyHomeRes = spawnSync("sh", [path.join(repo, "install.sh"), "--target", customTarget], {
      cwd: project,
      env: { ...env, HOME: "" },
      encoding: "utf8",
    });
    assert.equal(emptyHomeRes.status, 0, emptyHomeRes.stderr);
    assert.deepEqual(JSON.parse(emptyHomeRes.stdout), ["install", "--target", customTarget]);
    assert.doesNotMatch(emptyHomeRes.stderr, /unbound|not set/i);

    const source = await fs.readFile(INSTALL_SH, "utf8");
    const pipedNoHomeRes = spawnSync("sh", ["-s", "--", "--help"], {
      cwd: project,
      env: noHomeEnv,
      input: source,
      encoding: "utf8",
    });
    assert.equal(pipedNoHomeRes.status, 19, pipedNoHomeRes.stderr);
    assert.match(pipedNoHomeRes.stderr, /REMOTE_CLONE_ATTEMPT/);
    assert.doesNotMatch(pipedNoHomeRes.stderr, /unbound|not set/i);
  });
});

test("scripts/test.mjs strips Antigravity/plugin host env vars case-insensitively and cleans .tmp in finally", async () => {
  const src = await fs.readFile(TEST_RUNNER_SCRIPT, "utf8");
  const match = /const DROPPED_ENV = (new RegExp\([\s\S]*?\n\));/.exec(src);
  assert.ok(match?.[1], "Expected DROPPED_ENV RegExp in scripts/test.mjs");
  const droppedEnv = new Function(`return (${match[1]});`)() as RegExp;

  for (const droppedKey of [
    "GEMINI_HOME",
    "gemini_home",
    "PLUGIN_ROOT",
    "plugin_root",
    "AGY_PLUGIN_ROOT",
    "ANTIGRAVITY_LS_VERSION",
    "ANTIGRAVITY_APP_DATA_DIR",
    "antigravity_host_session",
    "AGY_FAST_AUTO_UPDATE",
    "HOME",
    "UserProfile",
    "GIT_CONFIG_GLOBAL",
    "GIT_DIR",
  ]) {
    assert.equal(droppedEnv.test(droppedKey), true, `Expected DROPPED_ENV to strip ${droppedKey}`);
  }

  for (const keptKey of ["PATH", "Path", "TMPDIR", "TEMP", "NODE_ENV", "CI", "USER", "LANG"]) {
    assert.equal(droppedEnv.test(keptKey), false, `Expected DROPPED_ENV to keep ${keptKey}`);
  }

  const finallyIdx = src.indexOf("} finally {");
  assert.ok(finallyIdx !== -1, "Expected finally block in scripts/test.mjs");
  const finallyBlock = src.slice(finallyIdx);
  assert.match(finallyBlock, /fs\.rm\(tmpDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}/);
  assert.match(finallyBlock, /fs\.rm\(testHome,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}/);
});

test("scripts/build.mjs marks all shebang entrypoints executable and stress-benchmark strips case-insensitive PATH", async () => {
  const buildSrc = await fs.readFile(BUILD_SCRIPT, "utf8");
  for (const bundleName of ["mcp-server.mjs", "benchmark.mjs", "updater.mjs"]) {
    const escaped = bundleName.replace(/\./g, "\\.");
    assert.match(
      buildSrc,
      new RegExp(`out:\\s*path\\.join\\(distDir,\\s*"${escaped}"\\),[^}]*?executable:\\s*true`),
      `Expected executable: true for ${bundleName}`,
    );
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(ROOT_DIR, "dist", bundleName));
      assert.notEqual(stat.mode & 0o111, 0, `Expected dist/${bundleName} to be executable`);
    }
  }

  const stressSrc = await fs.readFile(STRESS_BENCHMARK_SCRIPT, "utf8");
  assert.doesNotMatch(stressSrc, /env:\s*\{\s*\.\.\.process\.env,\s*PATH:\s*""\s*\}/);
  assert.match(stressSrc, /key\.toUpperCase\(\)\s*===\s*"PATH"/);
  assert.match(stressSrc, /nodeFallbackEnv\.PATH\s*=\s*""/);
});
