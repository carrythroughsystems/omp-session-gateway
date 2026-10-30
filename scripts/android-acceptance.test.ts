import { expect, test } from "bun:test";
import { AndroidTailnetRecoveryError, requireAndroidAcceptanceTailnetRecovery, withAndroidAcceptanceRestoration } from "./android-acceptance.ts";
import { AndroidAdbError, parseAndroidVpnNetwork, type AndroidAdbCommand } from "./android-device.ts";

const WIFI = "  NetworkAgentInfo{network{436} ni{WIFI CONNECTED extra: } lastValidated}\n";
const VPN = "  NetworkAgentInfo{network{437} ni{VPN CONNECTED extra: } }\n";

test("VPN recovery parses only connected agents in the current network list", () => {
  const dump = (current: string, later = "") => `Current Networks:\n${current}Network Requests:\n${later}`;
  expect(parseAndroidVpnNetwork(dump(WIFI + VPN))).toBe(true);
  expect(parseAndroidVpnNetwork(dump(VPN).replaceAll("\n", "\r\n"))).toBe(true);
  for (const state of ["CONNECTING", "DISCONNECTED", "CONNECTEDISH"]) {
    expect(parseAndroidVpnNetwork(dump(VPN.replace("CONNECTED", state)))).toBe(false);
  }
  expect(parseAndroidVpnNetwork(dump(WIFI, VPN))).toBe(false);
  expect(parseAndroidVpnNetwork(dump(`    request: ${VPN.trim()}\n`))).toBe(false);
  expect(parseAndroidVpnNetwork(dump(VPN.replace("VPN", "vpn")))).toBe(false);
  expect(() => parseAndroidVpnNetwork(`Network Requests:\n${VPN}`)).toThrow("Android connectivity state is missing Current Networks");
});

for (const cycle of ["lock", "airplane", "Doze"] as const) {
  test(`${cycle} recovery requires a live VPN and exactly one HTTPS navigation`, async () => {
    const calls: string[] = [], pauses: number[] = [], evidence: unknown[] = [];
    let time = 0, probes = 0;
    await requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid:9443", cycle, async (...args) => {
      calls.push(args.join(" "));
      time += 10;
      return `Current Networks:\n${WIFI}${calls.length >= 3 ? VPN : ""}Network Requests:\n`;
    }, {
      now: () => time,
      pause: async milliseconds => { pauses.push(milliseconds); time += milliseconds; },
      httpsProbe: async origin => {
        expect(origin).toBe("https://gateway-fixture.invalid:9443");
        expect(calls).toHaveLength(3);
        probes++;
        time += 25;
        return true;
      },
      recordEvidence: value => { evidence.push(value); },
    });
    expect(calls).toEqual(Array<string>(3).fill("shell dumpsys connectivity"));
    expect(pauses).toEqual([1_000, 1_000]);
    expect(probes).toBe(1);
    expect(evidence).toEqual([{
      vpnPresent: true, vpnRecoveredMs: 2_030, httpsProbed: true, httpsReachable: true, httpsProbeMs: 25, recoveredMs: 2_055,
    }]);
  });

  test(`${cycle} recovery fails precisely when VPN is absent for the whole bound`, async () => {
    const calls: string[] = [], pauses: number[] = [], evidence: unknown[] = [];
    let time = 0, probes = 0;
    await expect(requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid", cycle, async (...args) => {
      calls.push(args.join(" "));
      return `Current Networks:\n${WIFI}Network Requests:\n${VPN}`;
    }, {
      now: () => time,
      pause: async milliseconds => { pauses.push(milliseconds); time += milliseconds; },
      httpsProbe: async () => { probes++; return true; },
      recordEvidence: value => { evidence.push(value); },
    })).rejects.toMatchObject({
      name: "AndroidTailnetRecoveryError", cycle,
      message: `Pixel tailnet path did not recover after the ${cycle} cycle; reconnect Tailscale on the device (no device settings were changed)`,
    });
    expect(calls).toEqual(Array<string>(60).fill("shell dumpsys connectivity"));
    expect(pauses).toEqual(Array<number>(60).fill(1_000));
    expect(time).toBe(60_000);
    expect(probes).toBe(0);
    expect(evidence).toEqual([{
      vpnPresent: false, vpnRecoveredMs: null, httpsProbed: false, httpsReachable: false, httpsProbeMs: null, recoveredMs: null,
    }]);
  });

  test(`${cycle} recovery fails precisely when VPN exists but HTTPS is unreachable`, async () => {
    const calls: string[] = [], evidence: unknown[] = [];
    let probes = 0;
    await expect(requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid", cycle, async (...args) => {
      calls.push(args.join(" "));
      return `Current Networks:\n${VPN}Network Requests:\n`;
    }, {
      now: () => 0,
      pause: async () => { throw new Error("a connected VPN must not be polled again"); },
      httpsProbe: async () => { probes++; return false; },
      recordEvidence: value => { evidence.push(value); },
    })).rejects.toMatchObject({
      name: "AndroidTailnetRecoveryError", cycle,
      message: `Pixel tailnet path did not recover after the ${cycle} cycle; reconnect Tailscale on the device (no device settings were changed)`,
    });
    expect(calls).toEqual(["shell dumpsys connectivity"]);
    expect(probes).toBe(1);
    expect(evidence).toEqual([{
      vpnPresent: true, vpnRecoveredMs: 0, httpsProbed: true, httpsReachable: false, httpsProbeMs: 0, recoveredMs: null,
    }]);
  });
}

test("a VPN read completing after the recovery bound cannot trigger an HTTPS probe", async () => {
  let time = 0, probes = 0;
  await expect(requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid", "Doze", async () => {
    time = 60_001;
    return `Current Networks:\n${VPN}`;
  }, {
    now: () => time,
    httpsProbe: async () => { probes++; return true; },
    recordEvidence: evidence => {
      expect(evidence).toEqual({
        vpnPresent: true, vpnRecoveredMs: null, httpsProbed: false, httpsReachable: false, httpsProbeMs: null, recoveredMs: null,
      });
    },
  })).rejects.toBeInstanceOf(AndroidTailnetRecoveryError);
  expect(probes).toBe(0);
});

test("tailnet recovery preserves malformed connectivity and adb transport causes without probing", async () => {
  for (const cause of [new Error("Android connectivity state is missing Current Networks"), new AndroidAdbError(1)]) {
    await expect(requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid", "lock", async () => {
      if (cause instanceof AndroidAdbError) throw cause;
      return `Network Requests:\n${VPN}`;
    }, {
      httpsProbe: async () => { throw new Error("invalid connectivity must not reach HTTPS"); },
      recordEvidence: evidence => { expect(evidence.httpsProbed).toBe(false); },
    })).rejects.toMatchObject({
      name: "AndroidTailnetRecoveryError",
      cause: cause instanceof AndroidAdbError ? cause : expect.objectContaining({ message: cause.message }),
    });
  }
});

test("tailnet recovery retains HTTPS containment failures as causes", async () => {
  const cause = new Error("HTTPS browser cleanup failed");
  await expect(requireAndroidAcceptanceTailnetRecovery("https://gateway-fixture.invalid", "airplane",
    async () => `Current Networks:\n${VPN}`, {
      httpsProbe: async () => { throw cause; },
      recordEvidence: evidence => {
        expect(evidence.vpnPresent).toBe(true);
        expect(evidence.httpsProbed).toBe(true);
        expect(evidence.httpsReachable).toBe(false);
        expect(evidence.recoveredMs).toBeNull();
      },
    })).rejects.toMatchObject({ name: "AndroidTailnetRecoveryError", cause });
});

function radios() {
  const state = { airplane: false, wifi: true, mobile: false };
  const network = { vpn: true };
  const calls: string[] = [];
  const command: AndroidAdbCommand = async (...args) => {
    const call = args.join(" ");
    calls.push(call);
    if (call.startsWith("shell ping ")) return "1 packets transmitted, 1 received, 0% packet loss";
    if (call === "shell dumpsys connectivity") return `Current Networks:\n${WIFI}${network.vpn ? VPN : ""}Network Requests:\n`;
    if (args.includes("settings")) {
      const key = args.at(-1);
      if (key === "wifi_on") return state.wifi ? "1" : "0";
      if (key === "mobile_data") return state.mobile ? "1" : "0";
      if (key === "airplane_mode_on") return state.airplane ? "1" : "0";
      return "null";
    }
    if (args.includes("airplane-mode")) state.airplane = args.at(-1) === "enable";
    if (args.includes("wifi")) state.wifi = args.at(-1) === "enable";
    if (args.includes("data")) state.mobile = args.at(-1) === "enable";
    return "";
  };
  return { state, network, calls, command };
}

test("configured-origin reachability refuses DNS/loss after both probes fail, before acceptance or radio effects", async () => {
  for (const output of ["ping: unknown host gateway-fixture.invalid", "1 packets transmitted, 0 received, 100% packet loss"]) {
    const device = radios();
    let touchedBrowser = false;
    const command: AndroidAdbCommand = async (...args) => args.join(" ").startsWith("shell ping ")
      ? (device.calls.push(args.join(" ")), output) : device.command(...args);
    await expect(withAndroidAcceptanceRestoration(command, async () => {
      touchedBrowser = true;
    }, "https://gateway-fixture.invalid:9443", { httpsProbe: async () => false, recordEvidence: evidence => {
      expect(evidence).toEqual({ icmp: "unreachable", https: "unreachable", satisfiedBy: null });
    } })).rejects.toMatchObject({
      name: "AndroidReachabilityPreconditionError", reason: "unreachable",
      message: expect.stringContaining("connect Tailscale on the Pixel"),
    });
    expect(touchedBrowser).toBe(false);
    expect(device.calls).toEqual(["shell ping -c 1 -W 2 'gateway-fixture.invalid' || true"]);
  }
});

test("acceptance accepts device-origin HTTPS when ICMP is unavailable and records the satisfying probe", async () => {
  const device = radios(), evidence: unknown[] = [];
  let probes = 0, ran = false;
  const command: AndroidAdbCommand = async (...args) => args.join(" ").startsWith("shell ping ")
    ? "1 packets transmitted, 0 received, 100% packet loss" : device.command(...args);
  const result = await withAndroidAcceptanceRestoration(command, async () => {
    expect(evidence).toEqual([{ icmp: "unreachable", https: "reachable", satisfiedBy: "https" }]);
    ran = true;
    return "accepted";
  }, "https://gateway-fixture.invalid:9443", {
    httpsProbe: async origin => { expect(origin).toBe("https://gateway-fixture.invalid:9443"); probes++; return true; },
    recordEvidence: (value: unknown) => { evidence.push(value); },
  });
  expect(result).toBe("accepted");
  expect(ran).toBe(true);
  expect(probes).toBe(2);
  expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
});

test("configured-origin reachability preserves adb transport failure as a separate prerequisite diagnostic", async () => {
  let touchedBrowser = false;
  await expect(withAndroidAcceptanceRestoration(async () => { throw new AndroidAdbError(1); }, async () => {
    touchedBrowser = true;
  }, "https://gateway-fixture.invalid", {
    httpsProbe: async () => { throw new Error("HTTPS must not run without adb"); },
    recordEvidence: evidence => { expect(evidence).toEqual({ icmp: "failed", https: "not_run", satisfiedBy: null }); },
  })).rejects.toMatchObject({
    name: "AndroidReachabilityPreconditionError", reason: "adb-transport",
    message: expect.stringContaining("adb transport"),
  });
  expect(touchedBrowser).toBe(false);
});

test("unproven HTTPS containment or unavailable evidence cannot start the acceptance journey", async () => {
  const device = radios();
  let ran = false;
  const command: AndroidAdbCommand = async (...args) => args.join(" ").startsWith("shell ping ") ? "0 received" : device.command(...args);
  const original = new Error("HTTPS browser cleanup failed");
  await expect(withAndroidAcceptanceRestoration(command, async () => { ran = true; }, "https://gateway-fixture.invalid", {
    httpsProbe: async () => { throw original; },
    recordEvidence: evidence => { expect(evidence).toEqual({ icmp: "unreachable", https: "failed", satisfiedBy: null }); },
  })).rejects.toBe(original);
  await expect(withAndroidAcceptanceRestoration(command, async () => { ran = true; }, "https://gateway-fixture.invalid", {
    httpsProbe: async () => true, recordEvidence: () => { throw new Error("private evidence unavailable"); },
  })).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "private evidence unavailable" })] });
  expect(ran).toBe(false);
  expect(device.calls).toEqual([]);
});

test("acceptance preserves the phase failure alongside a restoration failure and still resets Doze and battery", async () => {
  const device = radios();
  const phase = Object.assign(new Error("PWA did not recover"), { phase: "airplane" });
  const restoration = new Error("radio mutation failed");
  let failure: unknown;
  try {
    await withAndroidAcceptanceRestoration(async (...args) => {
      if (args.includes("wifi")) throw restoration;
      return device.command(...args);
    }, async () => { throw phase; }, "https://gateway-fixture.invalid", { httpsProbe: async () => true });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(phase);
  expect((failure as AggregateError).errors).toContain(restoration);
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});

test("acceptance restores the Wi-Fi-on, data-off baseline rather than enabling roaming data", async () => {
  const device = radios();
  const result = await withAndroidAcceptanceRestoration(device.command, async () => {
    device.state.airplane = true;
    device.state.wifi = false;
    device.state.mobile = true;
    return "phase complete";
  }, "https://gateway-fixture.invalid", { httpsProbe: async () => true });
  expect(result).toBe("phase complete");
  expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
});

test("a successful adb response is not proof that acceptance restored the radio baseline", async () => {
  const device = radios();
  await expect(withAndroidAcceptanceRestoration(async (...args) => {
    if (args.includes("data")) return "";
    return device.command(...args);
  }, async () => { device.state.mobile = true; }, "https://gateway-fixture.invalid", { httpsProbe: async () => true })).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "radio baseline was not restored" })],
  });
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});

for (const missing of ["vpn", "https"] as const) {
  test(`acceptance restoration refuses a lost tailnet (${missing}) after restoring radios, Doze and battery`, async () => {
    const device = radios(), evidence: unknown[] = [];
    let time = 0, probes = 0;
    await expect(withAndroidAcceptanceRestoration(device.command, async () => {
      device.state.airplane = true;
      device.state.wifi = false;
      device.state.mobile = true;
      device.network.vpn = missing !== "vpn";
      return "must not reach the next stage";
    }, "https://gateway-fixture.invalid", {
      httpsProbe: async () => { probes++; return false; },
      tailnetRecovery: {
        now: () => time,
        pause: async milliseconds => { time += milliseconds; },
        recordEvidence: value => {
          expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
          expect(device.calls).toContain("shell dumpsys deviceidle unforce");
          expect(device.calls).toContain("shell dumpsys battery reset");
          evidence.push(value);
        },
      },
    })).rejects.toMatchObject({
      name: "AggregateError",
      message: "Android acceptance restoration failed",
      errors: [expect.objectContaining({
        name: "AndroidTailnetRecoveryError",
        cycle: "restoration",
        message: "Pixel tailnet path did not recover after the restoration cycle; reconnect Tailscale on the device (no device settings were changed)",
      })],
    });
    expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
    expect(device.calls.indexOf("shell dumpsys connectivity")).toBeGreaterThan(device.calls.indexOf("shell dumpsys battery reset"));
    expect(probes).toBe(missing === "vpn" ? 0 : 1);
    expect(time).toBe(missing === "vpn" ? 60_000 : 0);
    expect(evidence).toEqual([{
      vpnPresent: missing !== "vpn",
      vpnRecoveredMs: missing === "vpn" ? null : 0,
      httpsProbed: missing !== "vpn",
      httpsReachable: false,
      httpsProbeMs: missing === "vpn" ? null : 0,
      recoveredMs: null,
    }]);
  });
}

test("a lost restoration path preserves the cycle failure and does not skip equipment restoration", async () => {
  const device = radios(), phase = new AndroidTailnetRecoveryError("Doze");
  let time = 0, failure: unknown;
  try {
    await withAndroidAcceptanceRestoration(device.command, async () => {
      device.state.airplane = true;
      device.state.wifi = false;
      device.state.mobile = true;
      device.network.vpn = false;
      throw phase;
    }, "https://gateway-fixture.invalid", {
      httpsProbe: async () => { throw new Error("a missing VPN must not reach HTTPS"); },
      tailnetRecovery: {
        now: () => time,
        pause: async milliseconds => { time += milliseconds; },
        recordEvidence: () => {},
      },
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toBe("Android acceptance and restoration failed");
  expect((failure as AggregateError).errors).toEqual([phase, expect.objectContaining({
    name: "AndroidTailnetRecoveryError", cycle: "restoration",
  })]);
  expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});
