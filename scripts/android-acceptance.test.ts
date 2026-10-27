import { expect, test } from "bun:test";
import { withAndroidAcceptanceRestoration } from "./android-acceptance.ts";
import { AndroidAdbError, type AndroidAdbCommand } from "./android-device.ts";

function radios() {
  const state = { airplane: false, wifi: true, mobile: false };
  const calls: string[] = [];
  const command: AndroidAdbCommand = async (...args) => {
    const call = args.join(" ");
    calls.push(call);
    if (call.startsWith("shell ping ")) return "1 packets transmitted, 1 received, 0% packet loss";
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
  return { state, calls, command };
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
  expect(probes).toBe(1);
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
    }, async () => { throw phase; }, "https://gateway-fixture.invalid");
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
  }, "https://gateway-fixture.invalid");
  expect(result).toBe("phase complete");
  expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
});

test("a successful adb response is not proof that acceptance restored the radio baseline", async () => {
  const device = radios();
  await expect(withAndroidAcceptanceRestoration(async (...args) => {
    if (args.includes("data")) return "";
    return device.command(...args);
  }, async () => { device.state.mobile = true; }, "https://gateway-fixture.invalid")).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "radio baseline was not restored" })],
  });
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});
