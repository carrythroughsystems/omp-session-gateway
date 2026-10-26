import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { GatewayConfig } from "../src/config.ts";
import {
  installUserService,
  serviceDefinition,
  serviceDefinitionPath,
  type ServiceHost,
  serviceProgramBelongsTo,
  stopUserService,
  uninstallUserService,
} from "../src/service.ts";

const config: GatewayConfig = {
  http: { hostname: "127.0.0.1", port: 4317, publicOrigin: "https://gateway.example.ts.net", trustedDashboardOrigins: [] },
  fleet: { label: "gateway", targets: [] },
  speech: { browserRecognition: false },
  auth: { mode: "tailscale-serve", allowedLogins: ["user@example.com"] },
  omp: { discoveryDir: "/Users/test/.omp/run/collab-hosts", queryTimeoutMs: 1_500 },
  registry: { heartbeatSeconds: 10, ttlSeconds: 35, maxSessions: 100 },
  paths: {
    configDir: "/Users/test/.config/omp-session-gateway",
    stateDir: "/Users/test/.local/state/omp-session-gateway",
    runtimeDir: "/private/tmp/omp-session-gateway-501",
    tokenPath: "/Users/test/.config/omp-session-gateway/readiness-token",
    configPath: "/Users/test/.config/omp-session-gateway/config.json",
  },
};

/** A generated CLI path shaped like the one `install` passes: under the state dir it is rooted in. */
const installedCliPath = join(config.paths.stateDir, "installation", "versions", "0.1.0-a1b2c3d4e5f6", "apps", "gateway", "src", "cli.js");
/**
 * What a generated definition actually names for `installedCliPath`. The explicit `platform`
 * argument selects which document to generate, not the path semantics the process runs under:
 * `serviceDefinition` resolves the CLI path with the *host's* rules, so on Windows the separators
 * are backslashes and `resolve` also prepends the current drive. Expectations therefore have to go
 * through the same call rather than spell a path out, or they only hold on POSIX hosts.
 */
const installedCliArgument = resolve(installedCliPath);
/** 43 url-safe characters: one unpadded 256-bit base64url value, the only shape the code accepts. */
const boundInstance = "readiness_Instance-9".padEnd(43, "x");
/** The installing account every rendered Windows task is scoped to, as `whoami /user` reports it. */
const windowsUserSid = "S-1-5-21-1111111111-2222222222-3333333333-1001";

test.skipIf(process.platform === "win32")("qualification option preserves discarded raw streams and leaves ordinary service unchanged", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "service-qualification-"));
  try {
    const ordinary = serviceDefinition(config, "darwin", installedCliPath);
    const qualified = serviceDefinition(config, "darwin", installedCliPath, undefined, undefined, undefined, directory);
    expect(ordinary.content).not.toContain("--qualification-log-dir");
    expect(qualified.content).toContain("--qualification-log-dir");
    expect(qualified.content.match(/<string>\/dev\/null<\/string>/gu)).toHaveLength(2);
    expect(serviceDefinition(config, "linux", installedCliPath, undefined, undefined, undefined, directory).content).toContain("StandardOutput=null\nStandardError=null");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function withEnv(name: string, value: string | undefined, body: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/*
 * The helpers below stand in for the consumers of these generated files: systemd's unit parser,
 * launchd's plist reader, Task Scheduler's XML loader. Asserting on the whole document as one string
 * cannot distinguish a directive that landed in the wrong section, or an escaped payload from an
 * injected element, from a correct file. Parsing it the way the consumer does can.
 */

/** Directive lines grouped by `[Section]`; systemd silently ignores a directive in the wrong one. */
function unitSections(unit: string): ReadonlyMap<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of unit.split("\n")) {
    if (line.trim() === "") continue;
    const name = /^\[([^\]]+)\]$/u.exec(line)?.[1];
    if (name === undefined) {
      current.push(line);
      continue;
    }
    current = [];
    sections.set(name, current);
  }
  return sections;
}

function unitSection(unit: string, name: string): readonly string[] {
  const lines = unitSections(unit).get(name);
  if (lines === undefined) throw new Error(`unit has no [${name}] section`);
  return lines;
}

/** The values a `[Service]` directive resolves to once systemd's quoting is undone. */
function unitTokens(unit: string, directive: string): readonly string[] {
  const line = unitSection(unit, "Service").find(entry => entry.startsWith(`${directive}=`));
  if (line === undefined) throw new Error(`unit has no ${directive}`);
  const quoted = line.slice(directive.length + 1).matchAll(/"(?:[^"\\]|\\.)*"/gu);
  return [...quoted].map(match => JSON.parse(match[0]) as string);
}

function xmlUnescape(value: string): string {
  // `&amp;` last, or `&amp;lt;` would decode twice.
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

/**
 * Element names in document order, rejecting what a real parser rejects: unbalanced tags, raw markup
 * in text, or a bare ampersand. A dropped escape surfaces here as a structural difference rather
 * than as a string that merely looks odd.
 */
function xmlElements(document: string): readonly string[] {
  const body = document.replace(/<\?[^?]*\?>/gu, "").replace(/<!DOCTYPE[^>]*>/gu, "");
  const opened: string[] = [];
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<", cursor);
    const text = start === -1 ? body.slice(cursor) : body.slice(cursor, start);
    if (/[<>]/u.test(text)) throw new Error(`unescaped markup in text: ${text}`);
    if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(text)) throw new Error(`unescaped ampersand in text: ${text}`);
    if (start === -1) break;
    const end = body.indexOf(">", start);
    if (end === -1) throw new Error("unterminated tag");
    const tag = body.slice(start + 1, end);
    cursor = end + 1;
    if (tag.startsWith("/")) {
      if (stack.pop() !== tag.slice(1)) throw new Error(`unbalanced close tag: <${tag}>`);
      continue;
    }
    const name = tag.replace(/\/$/u, "").split(/\s/u)[0] ?? "";
    opened.push(name);
    if (!tag.endsWith("/")) stack.push(name);
  }
  if (stack.length > 0) throw new Error(`unclosed elements: ${stack.join(", ")}`);
  return opened;
}

function xmlText(document: string, element: string): string {
  const text = new RegExp(`<${element}>([^<]*)</${element}>`, "u").exec(document)?.[1];
  if (text === undefined) throw new Error(`document has no <${element}>`);
  return text;
}

function plistString(plist: string, key: string): string {
  const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(plist)?.[1];
  if (value === undefined) throw new Error(`plist has no ${key} string`);
  return value;
}

/** The argv launchd would exec, entities decoded. */
function plistProgramArguments(plist: string): readonly string[] {
  const body = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)?.[1];
  if (body === undefined) throw new Error("plist has no ProgramArguments array");
  return [...body.matchAll(/<string>([^<]*)<\/string>/gu)].map(match => xmlUnescape(match[1] ?? ""));
}

/** The `<Arguments>` string split back into the argv Task Scheduler would append to `<Command>`. */
function taskArguments(taskXml: string): readonly string[] {
  const quoted = xmlText(taskXml, "Arguments").matchAll(/&quot;(.*?)&quot;/gu);
  return [...quoted].map(match => xmlUnescape(match[1] ?? ""));
}

describe("service packaging", () => {
  test("generates hardened Linux systemd user service", () => {
    const definition = serviceDefinition(config, "linux");
    expect(definition.path).toEndWith("omp-session-gateway.service");
    expect(definition.content).toContain("WantedBy=default.target");
    expect(definition.content).toContain("NoNewPrivileges=true");
    expect(definition.content).toContain("ProtectSystem=strict");
    expect(definition.content).not.toContain("0.0.0.0");
  });

  test("lets systemd own a runtime directory that does not exist at boot", () => {
    // Regression for #69. ReadWritePaths= naming a missing path makes systemd refuse to start the
    // unit. The runtime directory only exists once the daemon has bound its socket, so the unit
    // installed fine and then failed after every reboot, leaving the gateway silently absent.
    // `serviceDefinition` compares against `join(XDG_RUNTIME_DIR, …)`, which uses the host
    // separator, so the fixture must be built the same way or this silently stops asserting
    // anything on Windows. The same separator assumption already broke the ownership fixtures once.
    const previous = process.env.XDG_RUNTIME_DIR;
    const xdgRuntimeDir = join("/run", "user", "1000");
    const runtimeDir = join(xdgRuntimeDir, "omp-session-gateway");
    process.env.XDG_RUNTIME_DIR = xdgRuntimeDir;
    try {
      const linuxConfig: GatewayConfig = {
        ...config,
        paths: { ...config.paths, runtimeDir },
      };
      const definition = serviceDefinition(linuxConfig, "linux");
      expect(definition.content).toContain("RuntimeDirectory=omp-session-gateway");
      // systemd defaults this to 0755, which the gateway's private-directory assertion rejects.
      expect(definition.content).toContain("RuntimeDirectoryMode=0700");
      // A RuntimeDirectory= path is implicitly writable; repeating it here is what broke boot.
      expect(definition.content).not.toContain(JSON.stringify(runtimeDir));
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("keeps a persistent runtime directory in ReadWritePaths", () => {
    // Without XDG_RUNTIME_DIR the runtime directory lives under the state directory, persists
    // across reboots, and must stay writable the ordinary way.
    const previous = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const definition = serviceDefinition(config, "linux");
      expect(definition.content).not.toContain("RuntimeDirectory=");
      expect(definition.content).toContain(JSON.stringify(config.paths.runtimeDir));
    } finally {
      if (previous !== undefined) process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  test("binds managed service readiness to the installed instance", () => {
    const readinessInstance = "R".repeat(43);
    const definition = serviceDefinition(config, "linux", "/private/runtime/cli.js", readinessInstance);
    expect(definition.content).toContain('"--readiness-instance"');
    expect(definition.content).toContain(`"${readinessInstance}"`);
    expect(() => serviceDefinition(config, "linux", "/private/runtime/cli.js", "invalid")).toThrow(
      "invalid service readiness instance",
    );
  });

  test("generates current-user macOS LaunchAgent", () => {
    const definition = serviceDefinition(config, "darwin");
    expect(definition.path).toEndWith("omp-session-gateway.plist");
    expect(definition.content).toContain("<key>RunAtLoad</key><true/>");
    expect(definition.content).toContain("<key>KeepAlive</key>");
    expect(definition.content).not.toContain("LaunchDaemons");
  });

  test("generates least-privilege Windows logon task", () => {
    const definition = serviceDefinition(config, "win32", undefined, undefined, undefined, windowsUserSid);
    expect(definition.path).toEndWith("omp-session-gateway-task.xml");
    expect(definition.content).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(definition.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(definition.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(definition.content).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
    expect(definition.content).not.toContain("HighestAvailable");
    expect(definition.content).not.toContain("cmd.exe");
  });
});

/**
 * Regression for a live outage on 2026-08-19. Service managers key their registry on identity no
 * filesystem override can scope — launchd on `gui/<uid>/<label>`, systemd on the unit name, Task
 * Scheduler on the task name — so an install rooted in a sandbox sees the real machine's service and
 * previously reported it as its own. An isolated archive smoke then ran `rotate-publisher-token`,
 * which took the active branch and booted out the production daemon.
 */
describe("loaded service ownership", () => {
  // Use the host separator for ordinary manager output. A separate fixture below proves serialized
  // definitions remain recognizable when their path syntax differs from the runner's.
  const stateDir = join(sep, "Users", "example", ".local", "state", "omp-session-gateway");
  const installedCli = join(stateDir, "installation", "versions", "0.1.0-77e3a6914cea", "apps", "gateway", "src", "cli.js");
  const otherRoot = join(sep, "tmp", "smoke.abc123", "state", "omp-session-gateway");
  const launchctlPrint = `gui/501/omp-session-gateway = {
	program = /opt/homebrew/Cellar/bun/1.3.14/bin/bun
	arguments = {
		/opt/homebrew/Cellar/bun/1.3.14/bin/bun
		${installedCli}
		serve
	}
}`;

  test("claims a loaded service whose program lives under this install root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, stateDir)).toBe(true);
  });

  test("disclaims a service installed from a different root", () => {
    expect(serviceProgramBelongsTo(launchctlPrint, otherRoot)).toBe(false);
  });

  test("disclaims a sibling root that shares a path prefix", () => {
    // Without the trailing separator this matches, and a second install silently adopts the first.
    expect(serviceProgramBelongsTo(launchctlPrint, `${stateDir}-2`)).toBe(false);
    expect(serviceProgramBelongsTo(join(`${stateDir}-2`, "installation", "x", "cli.js"), stateDir)).toBe(false);
  });

  test("disclaims when the service manager reports nothing loaded", () => {
    expect(serviceProgramBelongsTo(undefined, stateDir)).toBe(false);
  });

  test("reads a systemd ExecStart line", () => {
    const execStart = `{ path=/usr/bin/bun ; argv[]=/usr/bin/bun ${installedCli} serve ; ignore_errors=no }`;
    expect(serviceProgramBelongsTo(execStart, stateDir)).toBe(true);
    expect(serviceProgramBelongsTo(execStart, otherRoot)).toBe(false);
  });

  test("recognizes a JSON-escaped Windows path in a systemd definition on every runner", () => {
    const windowsState = String.raw`C:\Users\example\AppData\Local\omp-session-gateway`;
    const windowsCli = String.raw`${windowsState}\installation\versions\0.1.0-test\apps\gateway\src\cli.js`;
    const definition = `ExecStart=${JSON.stringify(windowsCli)}`;
    expect(serviceProgramBelongsTo(definition, windowsState)).toBe(true);
    expect(serviceProgramBelongsTo(definition, `${windowsState}-2`)).toBe(false);
  });

  test("disclaims a root whose name is a prefix of an unrelated directory's name", () => {
    // `/tmp/state` against `/tmp/statement/...`: the case the trailing separator exists for. A
    // substring test adopts an install that shares nothing but the first characters of its name.
    const root = join(sep, "tmp", "state");
    expect(serviceProgramBelongsTo(join(sep, "tmp", "statement", "installation", "cli.js"), root)).toBe(false);
    expect(serviceProgramBelongsTo(join(root, "installation", "cli.js"), root)).toBe(true);
  });

  test("disclaims a rendering that names the root but no program under it", () => {
    // The install root is not a program. A unit whose ExecStart was cleared, or a launchctl print
    // that only echoes the directory, must not read as ours: `active` gates stop and rotation.
    expect(serviceProgramBelongsTo(stateDir, stateDir)).toBe(false);
    expect(serviceProgramBelongsTo("", stateDir)).toBe(false);
  });
});

describe("systemd unit structure", () => {
  test("puts every directive in the section systemd reads it from", () => {
    // A directive in the wrong section is not an error, it is a silent no-op: `WantedBy=` outside
    // [Install] makes `systemctl --user enable` create no symlink, so the gateway never autostarts.
    const content = serviceDefinition(config, "linux").content;
    expect([...unitSections(content).keys()]).toEqual(["Unit", "Service", "Install"]);
    expect(unitSection(content, "Unit")).toContain("After=network-online.target");
    expect(unitSection(content, "Install")).toContain("WantedBy=default.target");
    const service = unitSection(content, "Service");
    expect(service).toContain("Restart=on-failure");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ProtectHome=read-only");
    expect(service.filter(line => line.startsWith("ExecStart=")).length).toBe(1);
  });

  test("names the unit file exactly what the systemctl calls address", () => {
    // Every systemctl call in service.ts hardcodes `omp-session-gateway.service`. A file written
    // under any other name is enabled by nothing, and status reports it as not installed.
    const definition = serviceDefinition(config, "linux");
    expect(basename(definition.path)).toBe(`${definition.identifier}.service`);
    expect(definition.path).toEndWith(join("systemd", "user", "omp-session-gateway.service"));
  });

  test("writes the unit where the systemd user manager looks for it", () => {
    const configHome = join(sep, "tmp", "xdg-config-home");
    withEnv("XDG_CONFIG_HOME", configHome, () => {
      expect(serviceDefinition(config, "linux").path).toBe(join(configHome, "systemd", "user", "omp-session-gateway.service"));
    });
    withEnv("XDG_CONFIG_HOME", undefined, () => {
      const fallback = join(homedir(), ".config", "systemd", "user", "omp-session-gateway.service");
      expect(serviceDefinition(config, "linux").path).toBe(fallback);
    });
  });

  test("hands systemd the runtime directory only when it is the one systemd would create", () => {
    // Continuation of #69. `RuntimeDirectory=omp-session-gateway` creates exactly
    // `$XDG_RUNTIME_DIR/omp-session-gateway`, so the decision turns on that exact path and not on
    // XDG_RUNTIME_DIR merely being set. Claiming it for a near-miss would leave the real runtime
    // directory unwritable under ProtectHome=, and create a stray directory nobody uses.
    const xdgRuntimeDir = join(sep, "run", "user", "1000");
    const nearMisses = [
      join(xdgRuntimeDir, "omp-session-gateway-2"),
      join(xdgRuntimeDir, "omp-session-gateway", "nested"),
      join(xdgRuntimeDir, "..", "omp-session-gateway"),
      join(config.paths.stateDir, "run"),
    ];
    withEnv("XDG_RUNTIME_DIR", xdgRuntimeDir, () => {
      for (const runtimeDir of nearMisses) {
        const content = serviceDefinition({ paths: { ...config.paths, runtimeDir } }, "linux").content;
        expect(content).not.toContain("RuntimeDirectory=");
        expect(unitTokens(content, "ReadWritePaths")).toContain(runtimeDir);
      }
      const exact = serviceDefinition({ paths: { ...config.paths, runtimeDir: join(xdgRuntimeDir, "omp-session-gateway") } }, "linux");
      expect(unitSection(exact.content, "Service")).toContain("RuntimeDirectory=omp-session-gateway");
      expect(unitSection(exact.content, "Service")).toContain("RuntimeDirectoryMode=0700");
      expect(unitTokens(exact.content, "ReadWritePaths")).toEqual([config.paths.configDir, config.paths.stateDir]);
    });
  });

  test("keeps the daemon's own directories writable under ProtectHome=read-only", () => {
    // ProtectSystem=strict plus ProtectHome=read-only makes everything read-only by default, so a
    // path dropped from here is a daemon that starts and then fails its first write.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const content = serviceDefinition(config, "linux").content;
      expect(unitTokens(content, "ReadWritePaths")).toEqual([
        config.paths.configDir,
        config.paths.stateDir,
        config.paths.runtimeDir,
      ]);
    });
  });

  test("quotes paths losslessly instead of letting one inject a directive", () => {
    // These paths come from flags and environment, into a file systemd parses line by line. A quote
    // or newline that survives unescaped appends directives of the caller's choosing.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const hostile = `${join(sep, "tmp", "gateway-state")}"\nExecStart=${join(sep, "bin", "sh")}`;
      const content = serviceDefinition({ paths: { ...config.paths, stateDir: hostile } }, "linux").content;
      expect(unitSection(content, "Service").filter(line => line.startsWith("ExecStart=")).length).toBe(1);
      expect(content.split("\n").length).toBe(serviceDefinition(config, "linux").content.split("\n").length);
      // Lossless, not merely safe: systemd must still exec on the exact directory it was given.
      expect(unitTokens(content, "ReadWritePaths")).toContain(hostile);
    });
  });

  test("execs an absolute program with no shell in between", () => {
    // systemd refuses an ExecStart that is not an absolute path, and there is no shell in the chain
    // to re-quote anything, so these tokens are what the kernel receives.
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const tokens = unitTokens(serviceDefinition(config, "linux", installedCliPath).content, "ExecStart");
      expect(tokens[0]).toBe(process.execPath);
      expect(tokens.at(-1)).toBe("serve");
      for (const token of tokens.slice(0, -1)) expect(isAbsolute(token)).toBe(true);
    });
  });
});

describe("macOS launch agent", () => {
  test("installs into the current user's LaunchAgents domain, never a system daemon", () => {
    // A plist under /Library/LaunchDaemons runs as root at boot. This service is a per-user agent by
    // design: it serves one logged-in user's sessions and owns files in that user's home.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(definition.path).toBe(join(homedir(), "Library", "LaunchAgents", "omp-session-gateway.plist"));
    expect(definition.path.startsWith(homedir() + sep)).toBe(true);
    expect(definition.content).not.toContain("UserName");
    expect(plistString(definition.content, "ProcessType")).toBe("Background");
  });

  test("labels the agent exactly what launchctl is asked to print and bootout", () => {
    // install/stop/uninstall all address `gui/<uid>/omp-session-gateway`. If the Label drifts from
    // the identifier, bootout targets a service that does not exist and stop silently does nothing.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(plistString(definition.content, "Label")).toBe(definition.identifier);
  });

  test("emits a plist a consumer can parse", () => {
    const content = serviceDefinition(config, "darwin", installedCliPath).content;
    expect(content).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain("-//Apple//DTD PLIST 1.0//EN");
    // Throws on unbalanced tags or raw markup in text, which is what a plist reader would do.
    const elements = xmlElements(content);
    expect(elements[0]).toBe("plist");
    expect(elements[1]).toBe("dict");
    expect(elements).toContain("array");
  });

  test("carries the paths it was given into the program arguments", () => {
    // The plist embeds argv and nothing else, so the config reaches it through the installed CLI
    // path, which `install` roots under the state directory it was configured with.
    const definition = serviceDefinition(config, "darwin", installedCliPath);
    expect(plistProgramArguments(definition.content)).toContain(installedCliArgument);
    expect(installedCliArgument.startsWith(resolve(config.paths.stateDir) + sep)).toBe(true);
  });

  test("escapes markup in a program path instead of emitting another plist key", () => {
    // On Windows the payload's own forward slashes are separators like any other, so `resolve`
    // rewrites them: `</string>` arrives as `\string>`. The assertions below therefore name only
    // characters no path rule touches, and the decoded round-trip at the end carries the exactness.
    const hostile = join(sep, "tmp", 'gateway&"<danger>"', "</string><key>RunAtLoad</key><false/><string>cli.js");
    const benign = serviceDefinition(config, "darwin", join(sep, "tmp", "gateway", "cli.js")).content;
    const injected = serviceDefinition(config, "darwin", hostile).content;
    // Escaping means the payload can only change text: the element structure is byte-for-byte the
    // same shape as a benign path's. Dropping xmlEscape diverges here immediately.
    expect(xmlElements(injected)).toEqual(xmlElements(benign));
    expect(injected).toContain("&lt;key&gt;");
    expect(injected).toContain("&amp;");
    expect(injected).toContain("&quot;");
    expect(injected).toContain("<key>RunAtLoad</key><true/>");
    expect(injected).not.toContain("<key>RunAtLoad</key><false/>");
    // And launchd still recovers the exact path it has to exec.
    expect(plistProgramArguments(injected)).toEqual([process.execPath, resolve(hostile), "serve"]);
  });
});

describe("windows scheduled task", () => {
  test("starts at the installing user's interactive logon rather than at boot (#90, #294)", () => {
    // Deliberate and documented: the gateway serves a logged-in user's sessions with that user's
    // token, so it starts with that user's session, not with the machine. The trigger names the user:
    // without a UserId it fires on anyone's logon, which only an administrator may register. Moving
    // to boot-start means changing this test on purpose rather than changing behaviour by accident.
    const content = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid).content;
    expect(content).toContain(`<LogonTrigger><Enabled>true</Enabled><UserId>${windowsUserSid}</UserId></LogonTrigger>`);
    expect(xmlElements(content).filter(element => element.endsWith("Trigger"))).toEqual(["LogonTrigger"]);
    expect(xmlText(content, "LogonType")).toBe("InteractiveToken");
    expect(content).not.toContain("BootTrigger");
    expect(content).not.toContain("ServiceAccount");
    expect(content).not.toContain("S4U");
    expect(content).not.toContain("Password");
  });

  test("refuses to render a task without the installing user's SID (#294)", () => {
    // Nothing but a SID may reach the trigger: an absent one is a task any logon starts, and markup
    // in one could add a principal or a second trigger.
    const rejected = [undefined, "", "DESKTOP\\gateway-user", "s-1-5-21-1001", `${windowsUserSid}</UserId><UserId>S-1-5-18`];
    for (const sid of rejected) {
      expect(() => serviceDefinition(config, "win32", installedCliPath, undefined, undefined, sid)).toThrow(
        "a Windows task definition needs the installing user's SID",
      );
    }
  });

  test("declares the UTF-16 encoding the installer writes and carries no BOM of its own", () => {
    // The installer serializes this document as UTF-16LE behind a hand-written BOM. Task Scheduler
    // refuses XML whose declaration disagrees with its bytes, and a BOM already in the string would
    // be encoded a second time and sit as a stray character in front of the declaration.
    const content = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid).content;
    expect(content).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
    expect(content).not.toContain("UTF-8");
    expect(content).not.toContain("\uFEFF");
  });

  test("splits the runtime from its arguments the way schtasks expects", () => {
    const content = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid).content;
    expect(xmlText(content, "Command")).toBe(process.execPath);
    expect(taskArguments(content)).toEqual([installedCliArgument, "serve"]);
    // Repeating the executable in <Arguments> would launch the runtime with itself as its script.
    expect(xmlText(content, "Arguments")).not.toContain(process.execPath);
  });

  test("writes the task definition inside the config directory it was given", () => {
    // schtasks reads this path, and install mkdirs its parent at 0700. A path outside the config
    // root escapes every sandbox an isolated install sets up.
    const definition = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid);
    expect(definition.path).toBe(join(config.paths.configDir, "omp-session-gateway-task.xml"));
  });

  test("registers one hard-terminable instance with no execution time limit", () => {
    // IgnoreNew keeps a second logon from starting a rival daemon on the same socket;
    // AllowHardTerminate is what lets the Task Scheduler end it; PT0S is what stops Task
    // Scheduler from killing a long-running service when the default execution time limit expires.
    const content = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid).content;
    expect(content).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(content).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
    expect(content).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  test("escapes markup in a program path instead of emitting another task element", () => {
    const hostile = join(sep, "tmp", "gateway&danger", "</Arguments><Exec><Command>evil.exe</Command><Arguments>cli.js");
    const benign = serviceDefinition(config, "win32", join(sep, "tmp", "gateway", "cli.js"), undefined, undefined, windowsUserSid).content;
    const injected = serviceDefinition(config, "win32", hostile, undefined, undefined, windowsUserSid).content;
    expect(xmlElements(injected)).toEqual(xmlElements(benign));
    expect(injected).toContain("&lt;Exec&gt;");
    expect(injected).toContain("&amp;danger");
    expect(injected).not.toContain("<Exec><Command>evil.exe");
    expect(xmlText(injected, "Command")).toBe(process.execPath);
  });
});

describe("service argv", () => {
  // The runtime here is bun, so the generated argv passes the script path explicitly; that is the
  // shape asserted below. These tokens are what the service manager execs, with no shell to re-split.
  test("threads the installed CLI into every platform's generated command", () => {
    const expected = [process.execPath, installedCliArgument, "serve"];
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      expect(unitTokens(serviceDefinition(config, "linux", installedCliPath).content, "ExecStart")).toEqual(expected);
    });
    expect(plistProgramArguments(serviceDefinition(config, "darwin", installedCliPath).content)).toEqual(expected);
    const task = serviceDefinition(config, "win32", installedCliPath, undefined, undefined, windowsUserSid).content;
    expect([xmlText(task, "Command"), ...taskArguments(task)]).toEqual(expected);
  });

  test("appends a bound readiness instance as a separate flag and value after the command", () => {
    // Two argv entries, and both after `serve`: the CLI reads argv[0] as the command and rejects an
    // unknown option, so a joined token or a flag ahead of the command is a daemon that will not
    // start. This is the handshake that proves the newly installed instance is the one answering.
    const expected = [process.execPath, installedCliArgument, "serve", "--readiness-instance", boundInstance];
    withEnv("XDG_RUNTIME_DIR", undefined, () => {
      const content = serviceDefinition(config, "linux", installedCliPath, boundInstance).content;
      expect(unitTokens(content, "ExecStart")).toEqual(expected);
    });
    const plist = serviceDefinition(config, "darwin", installedCliPath, boundInstance).content;
    expect(plistProgramArguments(plist)).toEqual(expected);
    const task = serviceDefinition(config, "win32", installedCliPath, boundInstance, undefined, windowsUserSid).content;
    expect([xmlText(task, "Command"), ...taskArguments(task)]).toEqual(expected);
  });

  test("omits the readiness flag entirely when no instance is bound", () => {
    // An empty or dangling `--readiness-instance` would make the daemon refuse to start; the flag
    // has to be absent, not present-and-empty.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const content = serviceDefinition(config, platform, installedCliPath, undefined, undefined, windowsUserSid).content;
      expect(content).not.toContain("--readiness-instance");
    }
  });

  test("falls back to the running script when no installed CLI is given", () => {
    // The pre-install path calls this before any runtime directory exists to point at. The fallback
    // still has to produce a complete argv: a missing or empty script argument leaves the runtime
    // with no program, and the service manager starts something that is not the gateway.
    const fallback = plistProgramArguments(serviceDefinition(config, "darwin").content);
    const explicit = plistProgramArguments(serviceDefinition(config, "darwin", installedCliPath).content);
    expect(fallback.length).toBe(explicit.length);
    expect(fallback[0]).toBe(process.execPath);
    expect(fallback.at(-1)).toBe("serve");
    expect(fallback.every(argument => argument.length > 0)).toBe(true);
    // `resolve("")` would yield the working directory, which is absolute and non-empty, and launchd
    // would faithfully hand that directory to bun as the script to run.
    expect(isAbsolute(fallback[1] ?? "")).toBe(true);
    expect(statSync(fallback[1] ?? ".").isFile()).toBe(true);
  });

  test("resolves a relative installed CLI to an absolute program path", () => {
    // Service managers exec from an unspecified working directory, so a relative script path is a
    // service that starts nothing.
    const relative = join("relative", "cli.js");
    const arguments_ = plistProgramArguments(serviceDefinition(config, "darwin", relative).content);
    expect(arguments_[1]).toBe(resolve(relative));
    expect(isAbsolute(arguments_[1] ?? "")).toBe(true);
  });

  test("refuses a readiness instance that is not exactly 43 url-safe characters", () => {
    // The instance is interpolated into a file the service manager parses and into an HMAC input, so
    // a permissive check is both an injection and a silent readiness bypass.
    expect(serviceDefinition(config, "linux", installedCliPath, boundInstance).content).toContain(boundInstance);
    const rejected = [
      boundInstance.slice(0, 42),
      `${boundInstance}x`,
      `${boundInstance.slice(0, 42)}=`,
      `${boundInstance.slice(0, 42)}.`,
      `${boundInstance.slice(0, 30)}\n${"x".repeat(12)}`,
      "",
    ];
    for (const instance of rejected) {
      expect(() => serviceDefinition(config, "linux", installedCliPath, instance)).toThrow(
        "invalid service readiness instance",
      );
    }
  });
});

describe("unsupported platforms", () => {
  test("refuses to invent a service definition for a platform it cannot install on", () => {
    // Returning something plausible here would write a file no service manager reads and report a
    // successful install.
    for (const platform of ["freebsd", "openbsd", "sunos", "aix"] as const) {
      expect(() => serviceDefinition(config, platform)).toThrow(`unsupported platform: ${platform}`);
    }
  });

  test("validates the readiness instance before it looks at the platform", () => {
    // Precedence decides which error the caller sees: a malformed token is the caller's bug and must
    // be named as such, even on a host that could never host the service anyway.
    expect(() => serviceDefinition(config, "sunos", installedCliPath, "short")).toThrow(
      "invalid service readiness instance",
    );
  });
});

interface FakeCommandResult {
  readonly ok: boolean;
  readonly stdout?: string;
}

interface FakeManager {
  readonly host: ServiceHost;
  /** Every command the flow issued, in order. */
  readonly commands: readonly (readonly string[])[];
  /** What the manager would execute for the label, and whether it is running it. */
  readonly state: { program: string | undefined; running: boolean; startLimited: boolean };
}

/** The manager verbs that change machine state; a refusal must have issued none of them. */
const mutatingVerbs = new Set([
  "daemon-reload",
  "enable",
  "disable",
  "reset-failed",
  "start",
  "restart",
  "stop",
  "bootout",
  "bootstrap",
  "/Create",
  "/Run",
  "/Delete",
]);

/** The Task Scheduler stop runs as a COM script; name it by its effect, not its source text. */
function isWindowsTaskStop(command: readonly string[]): boolean {
  return command[0] === "powershell.exe" && (command.at(-1) ?? "").includes("$task.Stop(");
}

function mutations(commands: readonly (readonly string[])[]): readonly string[] {
  return commands
    .filter(command => isWindowsTaskStop(command) || command.some(token => mutatingVerbs.has(token)))
    .map(command => (isWindowsTaskStop(command) ? "Task Scheduler: stop OMP Session Gateway" : command.join(" ")));
}

/**
 * A service manager that answers from state instead of from the machine running the suite.
 *
 * `program` is what it would execute for the gateway's label — the one piece of a manager's identity
 * that carries the install root — and undefined means nothing holds the label. `running` is separate
 * on purpose: systemd loads units it never started and Task Scheduler holds idle tasks, and both are
 * as destructible as a running one. Queries are answered from that state and mutations apply to it,
 * `adopts` being the program the definition under installation names. An unmodelled command throws
 * rather than reporting a plausible success.
 */
function fakeManager(
  platform: ServiceHost["platform"],
  initial: {
    readonly program?: string;
    readonly running?: boolean;
    readonly startLimited?: boolean;
    readonly adopts?: string;
    /** The stop cannot end the gateway's process before its deadline. */
    readonly stopHangs?: boolean;
    /** The Task Scheduler answers no query at all, as WMI once refused a standard user's network logon. */
    readonly schedulerUnavailable?: boolean;
    readonly homeDirectory?: string;
  } = {},
): FakeManager {
  const state = {
    program: initial.program,
    running: initial.running ?? false,
    startLimited: initial.startLimited ?? false,
  };
  const commands: string[][] = [];
  const uid = process.getuid?.() ?? 0;
  const unit = "omp-session-gateway.service";
  const task = "OMP Session Gateway";
  const target = `gui/${uid}/omp-session-gateway`;
  /** The manager's own rendering of the program it holds, in the shape the real one prints. */
  const rendered = (program: string): string => {
    if (platform === "linux") {
      return `{ path=${process.execPath} ; argv[]=${process.execPath} ${program} serve ; ignore_errors=no }\n`;
    }
    if (platform === "darwin") {
      return `${target} = {\n\tprogram = ${process.execPath}\n\targuments = {\n\t\t${process.execPath}\n\t\t${program}\n\t\tserve\n\t}\n}\n`;
    }
    return `<Task version="1.4">\n  <Actions Context="Author"><Exec><Command>${process.execPath}</Command><Arguments>&quot;${program}&quot; &quot;serve&quot;</Arguments></Exec></Actions>\n</Task>\n`;
  };
  const answer = (command: readonly string[]): FakeCommandResult => {
    const is = (...tokens: readonly string[]): boolean =>
      command.length === tokens.length && tokens.every((token, index) => command[index] === token);
    if (is("systemctl", "--user", "show", "-p", "ExecStart", "--value", unit)) {
      // systemctl exits zero for a unit it does not know and prints an empty value for it.
      return { ok: true, stdout: state.program === undefined ? "\n" : rendered(state.program) };
    }
    if (is("systemctl", "--user", "is-active", unit)) return { ok: state.running };
    if (is("systemctl", "--user", "is-enabled", unit)) return { ok: state.program !== undefined };
    if (is("systemctl", "--user", "daemon-reload")) {
      // Reloading is where the manager adopts the unit file the caller just wrote.
      if (initial.adopts !== undefined) state.program = initial.adopts;
      return { ok: true };
    }
    if (is("systemctl", "--user", "enable", unit)) return { ok: state.program !== undefined };
    if (is("systemctl", "--user", "reset-failed", unit)) {
      state.startLimited = false;
      return { ok: true };
    }
    if (is("systemctl", "--user", "start", unit) || is("systemctl", "--user", "restart", unit)) {
      if (state.startLimited) return { ok: false };
      state.running = state.program !== undefined;
      return { ok: state.program !== undefined };
    }
    if (is("systemctl", "--user", "stop", unit)) {
      state.running = false;
      return { ok: true };
    }
    if (is("systemctl", "--user", "disable", "--now", unit) || is("systemctl", "--user", "disable", unit)) {
      if (command.includes("--now")) state.running = false;
      state.program = undefined;
      return { ok: true };
    }
    if (is("launchctl", "print", `gui/${uid}`)) return { ok: true };
    if (is("launchctl", "print", target)) {
      return state.program === undefined ? { ok: false } : { ok: true, stdout: rendered(state.program) };
    }
    if (is("launchctl", "bootout", target)) {
      state.program = undefined;
      state.running = false;
      return { ok: true };
    }
    if (command[0] === "launchctl" && command[1] === "bootstrap") {
      state.program = initial.adopts;
      state.running = initial.adopts !== undefined;
      return { ok: true };
    }
    // Neither Task Scheduler script gets an answer from a scheduler that cannot be reached.
    if (command[0] === "powershell.exe" && initial.schedulerUnavailable) return { ok: false };
    // Stopping ends every instance and waits for the gateway's process; a missing task has nothing to stop.
    if (isWindowsTaskStop(command)) {
      if (initial.stopHangs && state.running) return { ok: false };
      state.running = false;
      return { ok: true };
    }
    // The state query names what the scheduler holds: no task by that name, an idle one, or a running one.
    if (command[0] === "powershell.exe") {
      return { ok: true, stdout: state.program === undefined ? "absent\r\n" : state.running ? "running\r\n" : "stopped\r\n" };
    }
    if (is("whoami.exe", "/user", "/fo", "csv", "/nh")) return { ok: true, stdout: `"desktop\\gateway-user","${windowsUserSid}"\r\n` };
    if (is("schtasks.exe", "/Query")) return { ok: true };
    if (is("schtasks.exe", "/Query", "/TN", task, "/XML")) {
      return state.program === undefined ? { ok: false } : { ok: true, stdout: rendered(state.program) };
    }
    if (is("schtasks.exe", "/Query", "/TN", task)) return { ok: state.program !== undefined };
    if (command[0] === "schtasks.exe" && command[1] === "/Create") {
      state.program = initial.adopts;
      return { ok: true };
    }
    if (is("schtasks.exe", "/Run", "/TN", task)) {
      state.running = state.program !== undefined;
      return { ok: state.program !== undefined };
    }
    if (is("schtasks.exe", "/Delete", "/TN", task, "/F")) {
      state.program = undefined;
      state.running = false;
      return { ok: true };
    }
    throw new Error(`fake service manager received an unmodelled command: ${command.join(" ")}`);
  };
  const record = (command: readonly string[]): FakeCommandResult => {
    commands.push([...command]);
    return answer(command);
  };
  return {
    state,
    commands,
    host: {
      platform,
      ...(initial.homeDirectory === undefined ? {} : { homeDirectory: initial.homeDirectory }),
      output: async command => {
        const result = record(command);
        return result.ok ? (result.stdout ?? "") : undefined;
      },
      succeeds: async command => record(command).ok,
      run: async command => {
        if (!record(command).ok) throw new Error(`${command[0] ?? "service command"} failed`);
      },
    },
  };
}

/** The staged program a definition names: `install` always roots it under the state directory. */
function stagedProgram(stateDir: string, version: string): string {
  return join(stateDir, "installation", "versions", version, "apps", "gateway", "src", "cli.js");
}

/**
 * Regression for the rest of the 2026-08-19 outage class: the predicate above was wired into one
 * platform and one moment.
 *
 * Ownership was consulted on macOS only, after the plist had already been written, and only when the
 * install was activating. Linux gated it behind `is-active`, so a foreign unit systemd had loaded but
 * never started was invisible and got reloaded, enabled and restarted; Windows gated it behind
 * `State -eq 'Running'`, so an idle foreign task was invisible and got recreated. `installed` is
 * label-scoped on both — `systemctl is-enabled`, `schtasks /Query` — so uninstall disabled, stopped
 * and deleted a foreign service as well, and its closing `rm` removed a definition path two roots
 * sharing a HOME compute identically.
 *
 * Producing a foreign holder for real means loading a service on the machine running the suite,
 * which is the accident under test, so these drive the injected `ServiceHost` instead.
 */
describe("service ownership across install roots", () => {
  const saved = { ...process.env };
  const roots: string[] = [];

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  /**
   * A throwaway install root with the XDG variables pointed into it, so the systemd definition path
   * — which comes from `XDG_CONFIG_HOME` rather than from the config — lands inside it too.
   */
  async function isolatedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gateway-service-"));
    roots.push(root);
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.XDG_RUNTIME_DIR = join(root, "run");
    return root;
  }

  function rootedConfig(root: string): GatewayConfig {
    const configDir = join(root, "config", "omp-session-gateway");
    return {
      ...config,
      paths: {
        configDir,
        stateDir: join(root, "state", "omp-session-gateway"),
        runtimeDir: join(root, "run", "omp-session-gateway"),
        tokenPath: join(configDir, "readiness-token"),
        configPath: join(configDir, "config.json"),
      },
    };
  }

  /** A program staged under a second install root on the same machine. */
  function foreignProgram(root: string): string {
    return stagedProgram(join(root, "other", "omp-session-gateway"), "0.1.0-f0f0f0f0f0f0");
  }

  test("refuses an unloaded foreign LaunchAgent definition before install or uninstall", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const homeDirectory = join(root, "home");
    const foreign = foreignProgram(root);
    const manager = fakeManager("darwin", { homeDirectory });
    const definition = serviceDefinition(target, "darwin", foreign, undefined, homeDirectory);
    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    await writeFile(definition.path, definition.content);

    await expect(
      installUserService(target, false, stagedProgram(target.paths.stateDir, "0.1.0-111111111111"), boundInstance, manager.host),
    ).rejects.toThrow("another gateway service already holds this launchd label from a different install root");
    await expect(uninstallUserService(target, true, manager.host)).rejects.toThrow(
      "another gateway service already holds this launchd label from a different install root",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    expect(manager.state.program).toBeUndefined();
  });

  test("fails closed before file mutation when the systemd ownership query is unavailable", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const manager = fakeManager("linux");
    const host: ServiceHost = {
      ...manager.host,
      output: async command => {
        await manager.host.output(command);
        return undefined;
      },
    };
    const definition = serviceDefinition(
      target,
      "linux",
      stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
    );
    await expect(stopUserService(target, host)).rejects.toThrow(
      "cannot verify systemd user unit name ownership",
    );

    await expect(
      installUserService(target, true, stagedProgram(target.paths.stateDir, "0.1.0-111111111111"), boundInstance, host),
    ).rejects.toThrow("cannot verify systemd user unit name ownership");
    expect(existsSync(dirname(definition.path))).toBe(false);

    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    await writeFile(definition.path, definition.content);
    await expect(uninstallUserService(target, true, host)).rejects.toThrow(
      "cannot verify systemd user unit name ownership",
    );
    expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    expect(mutations(manager.commands)).toEqual([]);
  });

  test("refuses to install a definition that does not identify this state root", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const manager = fakeManager("linux");
    const definitionPath = serviceDefinition(target, "linux").path;

    await expect(installUserService(target, false, undefined, undefined, manager.host)).rejects.toThrow(
      "gateway service program must be staged under the configured state directory",
    );

    expect(existsSync(definitionPath)).toBe(false);
    expect(mutations(manager.commands)).toEqual([]);
  });

  test("refuses a loaded but idle foreign systemd unit before writing or reloading anything", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const foreign = foreignProgram(root);
    // Never started, so `is-active` reports nothing holds the label and `show` reports otherwise.
    const manager = fakeManager("linux", { program: foreign, running: false });
    const definitionPath = serviceDefinition(target, "linux").path;

    await expect(
      installUserService(target, true, stagedProgram(target.paths.stateDir, "0.1.0-111111111111"), boundInstance, manager.host),
    ).rejects.toThrow("another gateway service already holds this systemd user unit name from a different install root");

    expect(mutations(manager.commands)).toEqual([]);
    expect(existsSync(definitionPath)).toBe(false);
    // Not even the directory: the refusal precedes the `mkdir`.
    expect(existsSync(dirname(definitionPath))).toBe(false);
    expect(manager.state.program).toBe(foreign);
  });

  test("refuses an idle foreign scheduled task before writing the definition or recreating it", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const foreign = foreignProgram(root);
    const manager = fakeManager("win32", { program: foreign, running: false });
    const definitionPath = serviceDefinitionPath(target, "win32");

    await expect(
      installUserService(target, true, stagedProgram(target.paths.stateDir, "0.1.0-111111111111"), boundInstance, manager.host),
    ).rejects.toThrow("another gateway service already holds this scheduled task name from a different install root");

    expect(mutations(manager.commands)).toEqual([]);
    expect(existsSync(definitionPath)).toBe(false);
    expect(existsSync(target.paths.configDir)).toBe(false);
    expect(manager.state.program).toBe(foreign);
  });

  test("installs when nothing holds the systemd unit name", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const manager = fakeManager("linux", { adopts: program });

    const definition = await installUserService(target, true, program, boundInstance, manager.host);

    expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    // A fake Linux manager does not give the Windows filesystem POSIX mode semantics; the native
    // Linux job owns this permission assertion.
    if (process.platform !== "win32") expect(statSync(definition.path).mode & 0o777).toBe(0o600);
    expect(mutations(manager.commands)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable omp-session-gateway.service",
      "systemctl --user reset-failed omp-session-gateway.service",
      "systemctl --user start omp-session-gateway.service",
    ]);
    expect(manager.state.program).toBe(program);
    expect(manager.state.running).toBe(true);
  });

  test("upgrades a unit this root already owns, starting it when systemd had it stopped", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const next = stagedProgram(target.paths.stateDir, "0.1.0-222222222222");
    const manager = fakeManager("linux", {
      program: stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
      running: false,
      adopts: next,
    });

    const definition = await installUserService(target, true, next, boundInstance, manager.host);

    expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    expect(mutations(manager.commands)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable omp-session-gateway.service",
      "systemctl --user reset-failed omp-session-gateway.service",
      "systemctl --user start omp-session-gateway.service",
    ]);
    expect(manager.state.program).toBe(next);
  });

  test("restarts instead of starting when the unit it replaces was already running", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const next = stagedProgram(target.paths.stateDir, "0.1.0-222222222222");
    const manager = fakeManager("linux", {
      startLimited: true,
      program: stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
      running: true,
      adopts: next,
    });

    await installUserService(target, true, next, boundInstance, manager.host);

    expect(mutations(manager.commands)).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable omp-session-gateway.service",
      "systemctl --user reset-failed omp-session-gateway.service",
      "systemctl --user restart omp-session-gateway.service",
    ]);
    expect(manager.state.running).toBe(true);
    expect(manager.state.startLimited).toBe(false);
  });

  test("creates and runs a task when nothing holds the task name", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const manager = fakeManager("win32", { adopts: program });

    const definition = await installUserService(target, true, program, boundInstance, manager.host);

    // UTF-16LE behind a hand-written BOM, which is the only encoding Task Scheduler loads.
    const written = await readFile(definition.path);
    expect([...written.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(written.subarray(2).toString("utf16le")).toBe(definition.content);
    // The trigger names the account `whoami` reported, never any user's logon (#294).
    expect(xmlText(definition.content, "UserId")).toBe(windowsUserSid);
    expect(mutations(manager.commands)).toEqual([
      `schtasks.exe /Create /TN OMP Session Gateway /XML ${definition.path} /F`,
      "schtasks.exe /Run /TN OMP Session Gateway",
    ]);
  });

  test("registers nothing when the installing user's SID is unavailable (#294)", async () => {
    // Falling back to a trigger without a UserId would register a task any logon starts, or fail
    // for a standard user only after the definition had been written.
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const manager = fakeManager("win32", { adopts: program });
    const host: ServiceHost = {
      ...manager.host,
      output: async command => (command[0] === "whoami.exe" ? undefined : manager.host.output(command)),
    };

    await expect(installUserService(target, true, program, boundInstance, host)).rejects.toThrow(
      "cannot determine the installing Windows user's SID",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(existsSync(serviceDefinitionPath(target, "win32"))).toBe(false);
    expect(manager.state.program).toBeUndefined();
  });

  test("stops, recreates and runs a task this root already owns", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const next = stagedProgram(target.paths.stateDir, "0.1.0-222222222222");
    const manager = fakeManager("win32", {
      program: stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
      running: true,
      adopts: next,
    });

    const definition = await installUserService(target, true, next, boundInstance, manager.host);

    expect(mutations(manager.commands)).toEqual([
      "Task Scheduler: stop OMP Session Gateway",
      `schtasks.exe /Create /TN OMP Session Gateway /XML ${definition.path} /F`,
      "schtasks.exe /Run /TN OMP Session Gateway",
    ]);
    expect(manager.state.program).toBe(next);
    expect(manager.state.running).toBe(true);
  });

  test("refuses to uninstall a foreign task, leaving its registration and definition alone", async () => {
    // `installed` is the task *name*, so this branch reached `/End` and `/Delete` on a task another
    // root owns, and the closing `rm` removed the definition both roots resolve to.
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const foreign = foreignProgram(root);
    const manager = fakeManager("win32", { program: foreign, running: true });
    const definitionPath = serviceDefinitionPath(target, "win32");
    await mkdir(dirname(definitionPath), { recursive: true, mode: 0o700 });
    await writeFile(definitionPath, "definition owned by the other root\n");

    await expect(uninstallUserService(target, true, manager.host)).rejects.toThrow(
      "another gateway service already holds this scheduled task name from a different install root",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(await readFile(definitionPath, "utf8")).toBe("definition owned by the other root\n");
    expect(manager.state.program).toBe(foreign);
    expect(manager.state.running).toBe(true);
  });

  test("refuses to uninstall a foreign unit, leaving it enabled and its definition in place", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const foreign = foreignProgram(root);
    const manager = fakeManager("linux", { program: foreign, running: true });
    const definitionPath = serviceDefinition(target, "linux").path;
    await mkdir(dirname(definitionPath), { recursive: true, mode: 0o700 });
    await writeFile(definitionPath, "definition owned by the other root\n");

    await expect(uninstallUserService(target, true, manager.host)).rejects.toThrow(
      "another gateway service already holds this systemd user unit name from a different install root",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(await readFile(definitionPath, "utf8")).toBe("definition owned by the other root\n");
    expect(manager.state.program).toBe(foreign);
    expect(manager.state.running).toBe(true);
  });

  test("uninstalls a unit this root owns", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const manager = fakeManager("linux", { program, running: true });
    const definition = serviceDefinition(target, "linux", program);
    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    await writeFile(definition.path, definition.content);

    await uninstallUserService(target, true, manager.host);

    expect(mutations(manager.commands)).toEqual([
      "systemctl --user disable --now omp-session-gateway.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(definition.path)).toBe(false);
    expect(manager.state.program).toBeUndefined();
    expect(manager.state.running).toBe(false);
  });

  test("preserves a definition another root writes after the manager mutation", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const foreignDefinition = serviceDefinition(target, "linux", foreignProgram(root));
    const definition = serviceDefinition(target, "linux", program);
    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    await writeFile(definition.path, definition.content);
    const manager = fakeManager("linux", { program, running: true });
    const host: ServiceHost = {
      ...manager.host,
      run: async command => {
        await manager.host.run(command);
        if (command.includes("disable")) await writeFile(definition.path, foreignDefinition.content);
      },
    };

    await expect(uninstallUserService(target, true, host)).rejects.toThrow(
      "another gateway service already holds this systemd user unit name from a different install root",
    );

    expect(await readFile(definition.path, "utf8")).toBe(foreignDefinition.content);
    expect(mutations(manager.commands)).toEqual(["systemctl --user disable --now omp-session-gateway.service"]);
  });

  test("leaves a running foreign task alone when asked to stop", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const foreign = foreignProgram(root);
    const manager = fakeManager("win32", { program: foreign, running: true });

    await expect(stopUserService(target, manager.host)).rejects.toThrow(
      "another gateway service already holds this scheduled task name from a different install root",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(manager.state.running).toBe(true);
  });

  test("rechecks ownership when a task is replaced after the active-status probe", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const manager = fakeManager("win32", {
      program: stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
      running: true,
    });
    const foreign = foreignProgram(root);
    let ownershipReads = 0;
    const host: ServiceHost = {
      ...manager.host,
      output: async command => {
        const rendered = await manager.host.output(command);
        if (command[0] === "schtasks.exe" && command.includes("/XML")) {
          ownershipReads += 1;
          if (ownershipReads === 2) manager.state.program = foreign;
        }
        return rendered;
      },
    };

    await expect(stopUserService(target, host)).rejects.toThrow(
      "another gateway service already holds this scheduled task name from a different install root",
    );

    expect(ownershipReads).toBe(3);
    expect(mutations(manager.commands)).toEqual([]);
    expect(manager.state.program).toBe(foreign);
    expect(manager.state.running).toBe(true);
  });

  test("stops a running task this root owns", async () => {
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const manager = fakeManager("win32", {
      program: stagedProgram(target.paths.stateDir, "0.1.0-111111111111"),
      running: true,
    });

    await stopUserService(target, manager.host);

    expect(mutations(manager.commands)).toEqual(["Task Scheduler: stop OMP Session Gateway"]);
    expect(manager.state.running).toBe(false);
  });

  test("fails closed when a stop cannot end the gateway, before re-registering", async () => {
    // Ending a task reports it Ready at once; only the process's exit frees its port for a restart.
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const current = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const next = stagedProgram(target.paths.stateDir, "0.1.0-222222222222");
    const manager = fakeManager("win32", { program: current, running: true, adopts: next, stopHangs: true });

    await expect(installUserService(target, true, next, boundInstance, manager.host)).rejects.toThrow(
      "running gateway task did not stop",
    );

    expect(mutations(manager.commands)).toEqual(["Task Scheduler: stop OMP Session Gateway"]);
    expect(manager.state.program).toBe(current);
  });

  test("fails closed when the task's state cannot be read, before touching the task", async () => {
    // A refused scheduler query once read as a stopped gateway: an uninstall trusting that answer
    // skips the stop and deletes the task while the gateway keeps running without it.
    const root = await isolatedRoot();
    const target = rootedConfig(root);
    const program = stagedProgram(target.paths.stateDir, "0.1.0-111111111111");
    const manager = fakeManager("win32", { program, running: true, schedulerUnavailable: true });

    await expect(uninstallUserService(target, true, manager.host)).rejects.toThrow(
      "cannot read the Windows gateway task's state",
    );

    expect(mutations(manager.commands)).toEqual([]);
    expect(manager.state.program).toBe(program);
  });
});
