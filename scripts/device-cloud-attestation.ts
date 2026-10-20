/** Capability-free development proof; never qualifies a release or contacts retained equipment. */
import { ALLOCATION_REPORT_EXPRESSION, type BrowserAllocationReport } from "./device-cloud-qualification.ts";
import { deviceCloudMachineOutcome } from "./device-cloud-availability.ts";
import { admitDeviceCloud } from "./device-cloud-runtime.ts";
import { TestingBotApi, readTestingBotCredentials } from "./testingbot.ts";
import { WebDriverSession, endWebDriverSession } from "./device-cloud-webdriver.ts";
import { serviceAccountTokenFile } from "./device-cloud-common.ts";

const PROBES = [
  { name: "iPhone 16 Pro", platform: "iOS", browser: "safari", family: "iphone", floor: 26 },
  { name: "iPhone Air", platform: "iOS", browser: "safari", family: "iphone", floor: 26 },
  { name: "iPhone 17", platform: "iOS", browser: "safari", family: "iphone", floor: 26 },
  { name: "Galaxy A55", platform: "Android", browser: "chrome", family: "android", floor: 14 },
] as const;
const VERSION = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,3}$/u;

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.length !== 1 || !["--admission", "--attest-public"].includes(argv[0]!)) {
    throw new Error("usage: bun scripts/device-cloud-attestation.ts --admission|--attest-public");
  }
  if (argv[0] === "--admission") {
    try {
      await admitDeviceCloud(process.env, "free");
      console.log(JSON.stringify({ admission: "free", passed: true, writes: 0 }));
    } catch (error) {
      const hold = deviceCloudMachineOutcome(error);
      if (hold === undefined) throw error;
      console.log(JSON.stringify({ ...hold, writes: 0 }));
    }
    return;
  }
  const credentials = await readTestingBotCredentials(serviceAccountTokenFile(process.env));
  const api = new TestingBotApi(credentials);
  const deadline = Date.now() + 15 * 60_000;
  let started = 0;
  for (const probe of PROBES) {
    if (Date.now() >= deadline) break;
    const free = await api.devices("available");
    const device = free.find(item => item.name === probe.name && item.platform === probe.platform && VERSION.test(item.version) && Number(item.version.split(".")[0]) >= probe.floor);
    if (device === undefined) {
      console.log(JSON.stringify({ device: probe.name, allocated: false, reason: "not-free" }));
      continue;
    }
    let id: string | undefined;
    let report: BrowserAllocationReport | undefined;
    let failed = false;
    try {
      started += 1;
      const allocation = await WebDriverSession.create("testingbot", credentials.key, credentials.secret, {
        platformName: probe.platform, browserName: probe.browser,
        "appium:deviceName": device.name, "appium:platformVersion": device.version,
        "tb:options": { realDevice: true, name: "omp public allocation attestation", screenrecorder: false, screenshot: false, recordLogs: false, public: false, maxduration: 180, idletimeout: 90 },
      }, async sessionId => { id = sessionId; });
      await allocation.session.navigate("https://example.com");
      const observed = await allocation.session.evaluate<BrowserAllocationReport>(ALLOCATION_REPORT_EXPRESSION);
      if (Object.keys(observed).sort().join(",") !== "browser,browserVersion,family,model,os" || observed.family !== probe.family || observed.browser !== probe.browser ||
        !VERSION.test(observed.browserVersion) || !VERSION.test(observed.os) || Number(observed.os.split(".")[0]) < probe.floor ||
        observed.os.split(".")[0] !== device.version.split(".")[0] ||
        (probe.platform === "iOS" ? allocation.capabilities.deviceName !== device.name || observed.model !== "" : !/^SM-[A-Z0-9]{1,12}$/u.test(observed.model))) {
        throw new Error("allocation did not attest");
      }
      report = observed;
    } catch { failed = true; }
    if (id !== undefined) {
      try { await endWebDriverSession("testingbot", credentials.key, credentials.secret, id); }
      catch { failed = true; }
      const finalize = Date.now() + 180_000;
      let audited = false;
      while (Date.now() <= finalize) {
        const record = await api.testRecord(id);
        if (record?.complete) {
          audited = !record.video && record.screenshots === 0;
          break;
        }
        await Bun.sleep(2_000);
      }
      if (!audited) failed = true;
      console.log(JSON.stringify({ device: probe.name, allocated: true, endedAndAudited: !failed, capabilitiesOpened: false, ...(report === undefined ? {} : { report }) }));
    } else console.log(JSON.stringify({ device: probe.name, allocated: false, reason: "allocation-failed" }));
    if (failed) throw new Error("bounded allocation attestation failed; stop before another allocation");
  }
  console.log(JSON.stringify({ sessionsStarted: started, maximumSessions: 4, capabilitiesOpened: false }));
}

if (import.meta.main) {
  try { await main(); }
  catch { console.error("bounded TestingBot public probe failed; no raw provider output retained"); process.exitCode = 1; }
}
