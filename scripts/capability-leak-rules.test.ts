import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { findCapabilityLeaks } from "./capability-leak-rules.ts";

const room = "R".repeat(16);
const key = "K".repeat(43);

test("detects URL, bare, legacy, percent-encoded, and authorization leaks", () => {
  const browserLink = ["https://my.omp.sh/", "#", room, ".", key].join("");
  const relayLink = ["wss://my.omp.sh/r/", room, ".", key].join("");
  const bareLink = [room, ".", key].join("");
  const legacyBareLink = [room, "#", key].join("");
  const encodedBrowserLink = ["https://my.omp.sh/", "#", room, "%23", key].join("");
  const encodedRelayLink = ["wss://my.omp.sh/r/", room, "%23", key].join("");
  const encodedBareLink = [room, "%23", key].join("");
  const bearer = ["Authorization", ": Bearer ", "T".repeat(48)].join("");
  expect(
    findCapabilityLeaks(
      [
        browserLink,
        relayLink,
        bareLink,
        legacyBareLink,
        encodedBrowserLink,
        encodedRelayLink,
        encodedBareLink,
        bearer,
      ].join("\n"),
    ).map(finding => finding.label),
  ).toEqual([
    "OMP browser capability",
    "OMP browser capability",
    "OMP relay capability",
    "OMP relay capability",
    "OMP bare capability",
    "OMP bare capability",
    "OMP bare capability",
    "long Bearer token",
    "OMP collaboration fragment",
    "OMP collaboration fragment",
  ]);
});

test("detects generated readiness tokens in JSON and token-file diagnostics", () => {
  const token = randomBytes(32).toString("base64url");
  expect(
    findCapabilityLeaks([JSON.stringify({ token }), `readiness-token=${token}`].join("\n")).map(
      finding => finding.label,
    ),
  ).toEqual(["gateway readiness token", "gateway readiness token"]);
  expect(findCapabilityLeaks(token).map(finding => finding.label)).toEqual(["raw readiness token"]);
});

test("detects discovery credentials and collaboration fragments without a URL prefix", () => {
  const token = randomBytes(32).toString("hex");
  expect(findCapabilityLeaks(JSON.stringify({ version: 1, token })).map(finding => finding.label)).toEqual([
    "OMP discovery token",
  ]);
  const fragment = ["#", room, ".", key].join("");
  expect(findCapabilityLeaks(fragment).map(finding => finding.label)).toEqual(["OMP collaboration fragment"]);
  expect(findCapabilityLeaks(JSON.stringify({ sha256: token }))).toEqual([]);
});

test("does not flag documented placeholders or ordinary URLs", () => {
  expect(findCapabilityLeaks("https://host.tailnet.ts.net <roomId>.<key> Authorization: Bearer <token>")).toEqual([]);
});

test("detects fleet grant bearers without echoing their credential material", () => {
  const grantId = ["a1111111", "b222", "4333", "8444", "c55555555555"].join("-");
  const credential = [grantId, "SYNTHETIC_FLEET_GRANT_".padEnd(43, "x")].join(".");
  for (const text of [credential, JSON.stringify({ authorization: `Bearer ${credential}` }),
    `Authorization: Bearer ${credential}`, `https://example.test/?credential=${credential}`]) {
    const findings = findCapabilityLeaks(text).filter(finding => finding.label === "fleet grant bearer");
    expect(findings).toEqual([{ label: "fleet grant bearer", byteOffset: text.indexOf(credential) }]);
    expect(JSON.stringify(findings).includes(credential)).toBe(false);
  }
  for (const text of ["<uuid>.<43-char base64url>", grantId, `${grantId}.short`,
    `${credential}x`, `prefix_${credential}`, credential.replace("-4333-", "-3333-")]) {
    expect(findCapabilityLeaks(text).some(finding => finding.label === "fleet grant bearer")).toBe(false);
  }
});