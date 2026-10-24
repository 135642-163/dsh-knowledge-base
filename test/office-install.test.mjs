/**
 * LibreOfficeKit 一键安装器：平台映射、包管理器探测、安装计划、执行/超时/校验、状态与单飞。
 * 全部注入假 spawn / 临时目录，不访问网络、不依赖本机已装引擎。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ENTRY_PACKAGE,
  INSTALL_DIR,
  PKG_VERSION,
  buildInstallPlan,
  detectToolchain,
  enginePackageFor,
  installOfficeKit,
  installedCliPath,
  officeEngineStatus,
  officeInstallDir,
  platformSupported,
  resetOfficeInstallForTests,
} from "../lib/web/office-install.js";
import { resolveOfficeCli } from "../lib/web/preview.js";

// ---------------------------------------------------------------------------
// 假子进程 / 假 spawn
// ---------------------------------------------------------------------------

function fakeChild({ stdout = "", stderr = "", code = 0, delay = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };
  if (!hang) {
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    }, delay).unref?.();
  }
  return child;
}

function makeSpawn(handler) {
  const calls = [];
  const spawn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  };
  return { spawn, calls };
}

const CAPABILITIES = {
  conversions: [{ inputs: ["doc", "docx", "odt"], outputs: ["pdf"] }],
  runtime: { version: PKG_VERSION, backend: "native" },
};

function writeCli(installDir) {
  const cli = installedCliPath(installDir);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "// fake libreoffice-kit cli\n", "utf8");
  return cli;
}

function baseDeps(installDir, overrides = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    env: { PATH: "" },
    home: installDir,
    installDir,
    toolchain: { kind: "pnpm", command: "pnpm", argsPrefix: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 平台 / 目录 / 工具链 / 安装计划（纯函数）
// ---------------------------------------------------------------------------

test("enginePackageFor maps every supported platform and rejects unknown ones", () => {
  assert.equal(enginePackageFor("darwin", "arm64"), "@deepseek-ai/libreoffice-kit-darwin-arm64");
  assert.equal(enginePackageFor("darwin", "x64"), "@deepseek-ai/libreoffice-kit-darwin-x64");
  assert.equal(enginePackageFor("win32", "x64"), "@deepseek-ai/libreoffice-kit-win32-x64");
  assert.equal(enginePackageFor("win32", "arm64"), "@deepseek-ai/libreoffice-kit-win32-arm64");
  assert.equal(enginePackageFor("linux", "x64"), "@deepseek-ai/libreoffice-kit-wasm");
  assert.equal(enginePackageFor("linux", "arm64"), "@deepseek-ai/libreoffice-kit-wasm");
  assert.equal(platformSupported("linux", "riscv64"), true);
  assert.equal(platformSupported("freebsd", "x64"), false);
  assert.throws(
    () => enginePackageFor("freebsd", "x64"),
    (error) => {
      assert.equal(error.name, "OfficeInstallError");
      assert.equal(error.code, "OFFICE_PLATFORM_UNSUPPORTED");
      assert.doesNotMatch(error.message, /freebsd/);
      return true;
    },
  );
});

test("officeInstallDir defaults to ~/.dsh/tools/libreoffice-kit and honours DSH_OFFICE_KIT_HOME", () => {
  assert.equal(
    officeInstallDir({ env: {}, home: "/home/u" }),
    join("/home/u", ".dsh", "tools", "libreoffice-kit"),
  );
  assert.equal(
    officeInstallDir({ env: { DSH_OFFICE_KIT_HOME: "~/opt/kit" }, home: "/home/u" }),
    join("/home/u", "opt", "kit"),
  );
  assert.equal(
    officeInstallDir({ env: { DSH_OFFICE_KIT_HOME: "/srv/kit" }, home: "/home/u" }),
    "/srv/kit",
  );
  assert.equal(INSTALL_DIR, officeInstallDir());
});

test("detectToolchain prefers bundled pnpm, then DSH_PNPM, then PATH", () => {
  const execPath = join("/opt", "dsh", "node", "bin", "node");
  const bundled = join("/opt", "dsh", "pnpm", "bin", "pnpm.mjs");
  assert.deepEqual(
    detectToolchain({
      env: { PATH: "/usr/bin" },
      execPath,
      exists: (candidate) => candidate === bundled,
      which: () => "/usr/bin/pnpm",
    }),
    { kind: "pnpm", command: execPath, argsPrefix: [bundled] },
  );

  assert.deepEqual(
    detectToolchain({
      env: { PATH: "", DSH_PNPM: "/custom/bin/pnpm" },
      execPath: "/nope/node",
      exists: () => false,
      which: () => null,
    }),
    { kind: "pnpm", command: "/custom/bin/pnpm", argsPrefix: [] },
  );

  const found = [];
  const toolchain = detectToolchain({
    env: { PATH: "" },
    execPath: "/nope/node",
    exists: () => false,
    which: (name) => {
      found.push(name);
      return name === "npm" ? "/usr/bin/npm" : null;
    },
  });
  assert.deepEqual(toolchain, { kind: "npm", command: "/usr/bin/npm", argsPrefix: [] });
  assert.deepEqual(found, ["pnpm", "npm"]);

  assert.equal(
    detectToolchain({ env: { PATH: "" }, execPath: "/nope/node", exists: () => false, which: () => null }),
    null,
  );
});

test("detectToolchain's default PATH lookup finds pnpm/npm without injection", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-toolchain-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), "#!/bin/sh\n", { mode: 0o755 });
  const toolchain = detectToolchain({
    env: { PATH: bin },
    execPath: join(root, "node", "bin", "node"),
    platform: "linux",
    which: undefined,
  });
  assert.equal(toolchain.kind, "npm");
  assert.equal(toolchain.command, join(bin, "npm"));
});

test("buildInstallPlan pins 0.2.2 for the entry and engine packages", () => {
  assert.equal(PKG_VERSION, "0.2.2");
  assert.equal(ENTRY_PACKAGE, "@deepseek-ai/libreoffice-kit@0.2.2");

  const pnpmPlan = buildInstallPlan({
    platform: "darwin",
    arch: "arm64",
    toolchain: { kind: "pnpm", command: "pnpm", argsPrefix: [] },
    installDir: "/tmp/kit",
  });
  assert.deepEqual(pnpmPlan.packages, [
    "@deepseek-ai/libreoffice-kit@0.2.2",
    "@deepseek-ai/libreoffice-kit-darwin-arm64@0.2.2",
  ]);
  assert.deepEqual(pnpmPlan.args, [
    "add",
    "--ignore-scripts",
    "@deepseek-ai/libreoffice-kit@0.2.2",
    "@deepseek-ai/libreoffice-kit-darwin-arm64@0.2.2",
  ]);
  assert.equal(pnpmPlan.command, "pnpm");
  assert.equal(pnpmPlan.installDir, "/tmp/kit");

  const npmPlan = buildInstallPlan({
    platform: "win32",
    arch: "x64",
    toolchain: { kind: "npm", command: "npm.cmd", argsPrefix: [] },
    installDir: "/tmp/kit",
  });
  assert.equal(npmPlan.action, "install");
  assert.equal(npmPlan.args[0], "install");
  assert.equal(npmPlan.packages[1], "@deepseek-ai/libreoffice-kit-win32-x64@0.2.2");

  const bundledPlan = buildInstallPlan({
    platform: "linux",
    arch: "arm64",
    toolchain: { kind: "pnpm", command: "/opt/dsh/node", argsPrefix: ["/opt/dsh/pnpm/bin/pnpm.mjs"] },
    installDir: "/tmp/kit",
  });
  assert.deepEqual(bundledPlan.args.slice(0, 3), ["/opt/dsh/pnpm/bin/pnpm.mjs", "add", "--ignore-scripts"]);
  assert.equal(bundledPlan.packages[1], "@deepseek-ai/libreoffice-kit-wasm@0.2.2");

  assert.throws(
    () => buildInstallPlan({ platform: "aix", arch: "ppc64", toolchain: null }),
    (error) => error.code === "OFFICE_PLATFORM_UNSUPPORTED",
  );
});

// ---------------------------------------------------------------------------
// installOfficeKit
// ---------------------------------------------------------------------------

test("installOfficeKit writes package.json, runs add --ignore-scripts, verifies CLI capabilities", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-ok-"));
  const cli = installedCliPath(root);
  const progress = [];
  const { spawn, calls } = makeSpawn((call) => {
    if (call.args.includes("capabilities")) {
      return fakeChild({ stdout: JSON.stringify(CAPABILITIES) });
    }
    writeCli(root);
    return fakeChild({ stdout: "added 2 packages in 4s\n" });
  });

  const result = await installOfficeKit({
    onProgress: (value) => progress.push(value),
    deps: baseDeps(root, { spawn }),
  });

  assert.equal(result.cliPath, cli);
  assert.equal(result.version, "0.2.2");
  assert.deepEqual(result.logTail, ["added 2 packages in 4s"]);
  assert.deepEqual(progress.map((item) => item.phase), ["download", "verify"]);

  const installCall = calls.find((call) => !call.args.includes("capabilities"));
  assert.equal(installCall.command, "pnpm");
  assert.deepEqual(installCall.args, [
    "add",
    "--ignore-scripts",
    "@deepseek-ai/libreoffice-kit@0.2.2",
    "@deepseek-ai/libreoffice-kit-darwin-arm64@0.2.2",
  ]);
  assert.equal(installCall.options.cwd, root);

  const capabilityCall = calls.find((call) => call.args.includes("capabilities"));
  assert.equal(capabilityCall.command, process.execPath);
  assert.deepEqual(capabilityCall.args, [cli, "capabilities"]);

  const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(project, { name: "dsh-office-kit", private: true });
});

test("installOfficeKit reports OFFICE_TOOLCHAIN_MISSING when no package manager is found", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-notool-"));
  let spawned = false;
  const { spawn } = makeSpawn(() => {
    spawned = true;
    return fakeChild();
  });
  await assert.rejects(
    installOfficeKit({
      deps: baseDeps(root, { toolchain: null, spawn }),
    }),
    (error) => {
      assert.equal(error.code, "OFFICE_TOOLCHAIN_MISSING");
      assert.match(error.message, /Node\.js|npm/);
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
  assert.equal(spawned, false);
});

test("installOfficeKit maps a non-zero exit to OFFICE_INSTALL_FAILED with a path-free message", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-fail-"));
  const { spawn } = makeSpawn(() => fakeChild({
    stderr: `npm ERR! permission denied at ${root}/node_modules\n`,
    code: 1,
  }));
  await assert.rejects(
    installOfficeKit({ deps: baseDeps(root, { spawn }) }),
    (error) => {
      assert.equal(error.name, "OfficeInstallError");
      assert.equal(error.code, "OFFICE_INSTALL_FAILED");
      assert.equal(error.message, "Office 转换引擎安装失败");
      assert.equal(error.details.exitCode, 1);
      assert.match(error.details.logTail.join("\n"), /permission denied/);
      assert.doesNotMatch(error.details.logTail.join("\n"), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("installOfficeKit kills the process tree and reports OFFICE_INSTALL_TIMEOUT", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-timeout-"));
  const child = fakeChild({ hang: true });
  const { spawn } = makeSpawn(() => child);
  const started = Date.now();
  await assert.rejects(
    installOfficeKit({ timeoutMs: 40, deps: baseDeps(root, { spawn }) }),
    (error) => {
      assert.equal(error.code, "OFFICE_INSTALL_TIMEOUT");
      assert.equal(error.message, "Office 转换引擎安装超时");
      return true;
    },
  );
  assert.equal(child.killed, true);
  assert.ok(Date.now() - started < 3000, "timeout must not wait for the child process");
});

test("installOfficeKit reports OFFICE_VERIFY_FAILED when capabilities stays unusable", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-verify-"));
  const { spawn } = makeSpawn((call) => {
    if (call.args.includes("capabilities")) {
      return fakeChild({ stdout: JSON.stringify({ runtime: { version: "0.2.2" } }) });
    }
    writeCli(root);
    return fakeChild({ stdout: "ok\n" });
  });
  await assert.rejects(
    installOfficeKit({ deps: baseDeps(root, { spawn }) }),
    (error) => {
      assert.equal(error.code, "OFFICE_VERIFY_FAILED");
      assert.equal(error.message, "Office 转换引擎安装后校验失败");
      return true;
    },
  );
});

test("installOfficeKit single-flights concurrent callers into one spawn", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-install-single-"));
  let installSpawns = 0;
  const { spawn } = makeSpawn((call) => {
    if (call.args.includes("capabilities")) {
      return fakeChild({ stdout: JSON.stringify(CAPABILITIES) });
    }
    installSpawns += 1;
    writeCli(root);
    return fakeChild({ stdout: "ok\n", delay: 20 });
  });
  const deps = baseDeps(root, { spawn });
  const [first, second] = await Promise.all([
    installOfficeKit({ deps }),
    installOfficeKit({ deps }),
  ]);
  assert.equal(installSpawns, 1);
  assert.equal(first.cliPath, second.cliPath);
});

// ---------------------------------------------------------------------------
// officeEngineStatus
// ---------------------------------------------------------------------------

test("officeEngineStatus caches a successful capabilities probe for 5 seconds", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-status-ok-"));
  const cli = writeCli(root);
  let probes = 0;
  const deps = baseDeps(root, {
    resolveCli: () => cli,
    exists: () => true,
    capabilities: async () => {
      probes += 1;
      return CAPABILITIES;
    },
    now: () => 1000,
  });
  const first = await officeEngineStatus({ deps });
  const second = await officeEngineStatus({ deps });

  assert.equal(first.available, true);
  assert.equal(first.running, false);
  assert.equal(first.toolchain, "pnpm");
  assert.equal(first.canInstall, true);
  assert.equal(first.version, "0.2.2");
  assert.deepEqual(second, first);
  assert.equal(probes, 1, "second status within 5s must hit the cache");
});

test("officeEngineStatus reports missing engine, missing toolchain and broken engine", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-status-missing-"));
  const empty = await mkdtemp(join(tmpdir(), "office-status-empty-"));
  const cli = writeCli(root);

  const missing = await officeEngineStatus({
    deps: baseDeps(empty, { resolveCli: () => null }),
  });
  assert.equal(missing.available, false);
  assert.equal(missing.canInstall, true);
  assert.equal(missing.reason, "engine-missing");

  const noToolchain = await officeEngineStatus({
    deps: baseDeps(empty, { resolveCli: () => null, toolchain: null }),
  });
  assert.equal(noToolchain.available, false);
  assert.equal(noToolchain.canInstall, false);
  assert.equal(noToolchain.toolchain, null);
  assert.equal(noToolchain.reason, "toolchain-missing");

  const unsupported = await officeEngineStatus({
    deps: baseDeps(empty, { platform: "aix", arch: "ppc64", resolveCli: () => null }),
  });
  assert.equal(unsupported.available, false);
  assert.equal(unsupported.canInstall, false);
  assert.equal(unsupported.reason, "unsupported-platform");

  resetOfficeInstallForTests();
  const broken = await officeEngineStatus({
    deps: baseDeps(root, {
      resolveCli: () => cli,
      exists: () => true,
      capabilities: async () => null,
    }),
  });
  assert.equal(broken.available, false);
  assert.equal(broken.canInstall, true);
  assert.equal(broken.reason, "engine-broken");
});

test("DSH_OFFICE_KIT_HOME is honoured by resolveOfficeCli and officeEngineStatus", async () => {
  resetOfficeInstallForTests();
  const home = await mkdtemp(join(tmpdir(), "office-status-home-"));
  const kit = join(home, "custom-kit");
  const cli = writeCli(kit);
  const env = { PATH: "", DSH_OFFICE_KIT_HOME: kit };
  assert.equal(resolveOfficeCli("", { env, home }), cli);

  const status = await officeEngineStatus({
    deps: {
      platform: "darwin",
      arch: "arm64",
      env,
      home,
      installDir: kit,
      toolchain: { kind: "npm", command: "npm", argsPrefix: [] },
      capabilities: async () => CAPABILITIES,
      exists: existsSync,
    },
  });
  assert.equal(status.available, true);
  assert.equal(status.installDir, kit);
  resetOfficeInstallForTests();
});

test("officeEngineStatus reports running while an install is in flight", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-status-running-"));
  const child = fakeChild({ hang: true });
  let spawned = false;
  const { spawn } = makeSpawn(() => {
    spawned = true;
    return child;
  });
  const deps = baseDeps(root, { spawn });
  const installing = installOfficeKit({ deps });
  for (let attempt = 0; attempt < 100 && !spawned; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(spawned, true);

  const status = await officeEngineStatus({ deps });
  assert.equal(status.running, true);
  assert.equal(status.available, false);
  assert.equal(status.reason, "installing");

  child.emit("close", 1);
  await assert.rejects(installing, (error) => error.code === "OFFICE_INSTALL_FAILED");
  resetOfficeInstallForTests();
});

test("resetOfficeInstallForTests clears the single-flight marker and status cache", async () => {
  resetOfficeInstallForTests();
  const root = await mkdtemp(join(tmpdir(), "office-status-reset-"));
  const cli = writeCli(root);
  let probes = 0;
  const deps = baseDeps(root, {
    resolveCli: () => cli,
    exists: () => true,
    capabilities: async () => {
      probes += 1;
      return CAPABILITIES;
    },
  });
  await officeEngineStatus({ deps });
  resetOfficeInstallForTests();
  await officeEngineStatus({ deps });
  assert.equal(probes, 2);
});
