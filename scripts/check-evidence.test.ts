import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEvidence, mentionsCandidate, parseLedger } from "./check-evidence.ts";
import { validateEvidenceRecord, type EvidenceAssertion, type EvidenceRecord } from "./evidence-schema.ts";
import { HANG_DEADLINE_MS } from "./test-support.ts";

setDefaultTimeout(2 * HANG_DEADLINE_MS);

/**
 * A ledger fixture with the shapes that matter: a vocabulary table whose statuses sit in the first
 * cell and must not be read as rows, and gate rows at each status the project uses.
 */
const LEDGER = [
  "## Status rules",
  "",
  "| Status | Meaning |",
  "|---|---|",
  "| **PASS** | The named scope has current, reproducible evidence. |",
  "| **PARTIAL** | Some evidence exists, but the complete scenario has not passed. |",
  "",
  "## Alpha gate ledger",
  "",
  "| Release gate | Status | Evidence or missing proof | Required to close |",
  "|---|---|---|---|",
  "| Linux host lifecycle | **PASS** | Reboot and login persistence measured against `v0.1.0-prealpha.17`. | Repeat on the next candidate. |",
  "| Windows host lifecycle | **PARTIAL** | The reboot half is open against `v0.1.0-prealpha.17`. | Fix the logon trigger. |",
  "| Self-hosted relay | **N/A** | Deliberately excluded and deferred. | Do not advertise. |",
].join("\n");

const PASSING: EvidenceAssertion = {
  name: "gateway daemon present after reboot",
  narrative: "the daemon was listening again after the reboot",
  measured: "present",
  outcome: "pass",
};

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schemaVersion: 1,
    row: "Linux host lifecycle",
    candidate: "v0.1.0-prealpha.17",
    platform: "linux-x86_64",
    osVersion: "Debian 13 (trixie) kernel 6.12.94",
    recordedAt: "2026-08-21T09:30:00Z",
    assertions: [PASSING],
    ...overrides,
  };
}

/**
 * The record that reproduces the incident this checker exists for: the reboot-persistence lane
 * printed one session for the qualified user and the narrative claimed the count was zero. The lane
 * called the assertion a pass, so nothing but the count comparison can catch it.
 */
const PERSISTENCE_BUG = evidence({
  assertions: [
    {
      name: "no session of class user",
      narrative: "the reboot proof holds only because the session count is zero {count=0}",
      measured: "1",
      outcome: "pass",
    },
  ],
});

describe("ledger parsing", () => {
  test("reads every status row and no vocabulary row", () => {
    expect(parseLedger(LEDGER).map(row => [row.name, row.status, row.line])).toEqual([
      ["Linux host lifecycle", "PASS", 12],
      ["Windows host lifecycle", "PARTIAL", 13],
      ["Self-hosted relay", "N/A", 14],
    ]);
  });

  test("reads the real ledger", async () => {
    // Content assertions are avoided on purpose: this document changes hourly and the parser's
    // contract is structural. What must hold is that real rows are found, that every status is one
    // the document's own vocabulary defines, and that the vocabulary table is not mistaken for rows.
    const rows = parseLedger(await readFile(new URL("../docs/RELEASE_STATUS.md", import.meta.url), "utf8"));
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter(row => row.name.includes("PASS") || row.name === "Status")).toEqual([]);
    expect(rows.filter(row => row.text.trim() === "")).toEqual([]);
  });
});

describe("evidence record validation", () => {
  test("accepts a well-formed record", () => {
    expect(validateEvidenceRecord(JSON.parse(JSON.stringify(evidence())))).toEqual({ ok: true, record: evidence() });
  });

  test("rejects an unknown field instead of ignoring it", () => {
    // The whole reason validation is strict: a lane that renames a field must fail, not quietly
    // emit a record with no measurement in it that still reads like proof.
    expect(validateEvidenceRecord({ ...evidence(), sessionCount: 0 })).toEqual({
      ok: false,
      errors: ["record.sessionCount: unknown field"],
    });
    expect(validateEvidenceRecord(evidence({ assertions: [{ ...PASSING, value: "present" } as EvidenceAssertion] }))).toEqual({
      ok: false,
      errors: ["record.assertions[0].value: unknown field"],
    });
  });

  test("rejects records that cannot be trusted to mean anything", () => {
    const errorsFor = (input: unknown): readonly string[] => {
      const result = validateEvidenceRecord(input);
      return result.ok ? [] : result.errors;
    };
    expect(errorsFor({ ...evidence(), schemaVersion: 2 })).toEqual(["record.schemaVersion: expected 1, got 2"]);
    expect(errorsFor(evidence({ assertions: [] }))).toEqual(["record.assertions: must contain at least one assertion"]);
    expect(errorsFor(evidence({ row: "  " }))).toEqual(["record.row: must not be empty"]);
    // `Date.parse` rolls this into March; a timestamp that silently moves decides which record is
    // most recent, so it is refused rather than normalised.
    expect(errorsFor(evidence({ recordedAt: "2026-02-31T00:00:00Z" }))).toEqual([
      'record.recordedAt: "2026-02-31T00:00:00Z" is not a real instant',
    ]);
    expect(errorsFor(evidence({ recordedAt: "2026-08-21 09:30" }))).toEqual([
      'record.recordedAt: expected an ISO 8601 UTC instant such as 2026-08-21T09:30:00Z, got "2026-08-21 09:30"',
    ]);
    expect(errorsFor(evidence({ assertions: [{ ...PASSING, outcome: "PASS" } as unknown as EvidenceAssertion] }))).toEqual([
      'record.assertions[0].outcome: expected one of pass, fail, got "PASS"',
    ]);
    expect(
      errorsFor(evidence({ assertions: [{ ...PASSING, narrative: "held {count=0} of {count=1} samples" }] })),
    ).toEqual([
      "record.assertions[0].narrative: states 2 count claims; an assertion measures one value, so it may state at most one",
    ]);
  });
});

describe("evidence versus ledger", () => {
  const rows = parseLedger(LEDGER);

  test("accepts records that agree with the ledger", () => {
    expect(checkEvidence(rows, [{ source: "persistence.json", record: evidence() }])).toEqual([]);
  });

  test("rejects a narrative claiming zero sessions when the measurement is one", () => {
    // The persistence bug, reconstructed. Remove the count comparison from `checkEvidence` and this
    // is the test that goes red: the record is otherwise valid, its row exists, its candidate is
    // cited, and the lane recorded the assertion as a pass.
    const found = checkEvidence(rows, [{ source: "persistence.json", record: PERSISTENCE_BUG }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.row).toBe("Linux host lifecycle");
    expect(found[0]?.expectation).toBe('assertion "no session of class user" claims count 0');
    expect(found[0]?.measured).toBe("1");
  });

  test("rejects a count claim whose measurement is not a count", () => {
    const found = checkEvidence(rows, [
      { source: "capacity.json", record: evidence({ assertions: [{ ...PASSING, narrative: "all fresh {count=50}", measured: "50 of 50" }] }) },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.measured).toBe('"50 of 50", which is not a count');
  });

  test("rejects a record naming a row the ledger does not have", () => {
    const found = checkEvidence(rows, [{ source: "renamed.json", record: evidence({ row: "Linux host lifecycle qualification" }) }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.expectation).toBe("a ledger row with this name");
    expect(found[0]?.measured).toBe("no row in the ledger carries it");
  });

  test("matches row names across Markdown punctuation and case", () => {
    expect(checkEvidence(rows, [{ source: "case.json", record: evidence({ row: "`Linux  host` **lifecycle**" }) }])).toEqual([]);
  });

  test("rejects a record citing a candidate the row never mentions", () => {
    const found = checkEvidence(rows, [{ source: "stale.json", record: evidence({ candidate: "v0.1.0-prealpha.13" }) }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.measured).toBe("candidate v0.1.0-prealpha.13, which the row text does not mention");
  });

  test("does not accept a candidate that is only a prefix of the cited one", () => {
    // `v0.1.0-prealpha.1` is a different artifact from `v0.1.0-prealpha.17`, and a truncated tag is
    // exactly the transcription slip this check is for.
    expect(mentionsCandidate("measured against `v0.1.0-prealpha.17`.", "v0.1.0-prealpha.1")).toBe(false);
    expect(mentionsCandidate("measured against `v0.1.0-prealpha.17`.", "v0.1.0-prealpha.17")).toBe(true);
  });

  test("rejects a PASS row whose most recent evidence contains a failure", () => {
    const failing = evidence({
      recordedAt: "2026-08-21T11:00:00Z",
      assertions: [{ ...PASSING, measured: "absent", outcome: "fail" }],
    });
    const found = checkEvidence(rows, [
      { source: "old.json", record: evidence() },
      { source: "new.json", record: failing },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.row).toBe("Linux host lifecycle");
    expect(found[0]?.expectation).toBe(
      'line 12 claims PASS, so assertion "gateway daemon present after reboot" of 2026-08-21T11:00:00Z must pass',
    );
    expect(found[0]?.measured).toBe("absent (outcome fail)");
    expect(found[0]?.source).toBe("new.json");
  });

  test("treats a failure that a later record supersedes as history", () => {
    const found = checkEvidence(rows, [
      { source: "old.json", record: evidence({ recordedAt: "2026-08-20T09:30:00Z", assertions: [{ ...PASSING, measured: "absent", outcome: "fail" }] }) },
      { source: "new.json", record: evidence() },
    ]);
    expect(found).toEqual([]);
  });

  test("leaves a failure on a row that does not claim PASS alone", () => {
    // A PARTIAL row is allowed to have failing evidence; that is what PARTIAL means.
    const found = checkEvidence(rows, [
      {
        source: "windows.json",
        record: evidence({ row: "Windows host lifecycle", assertions: [{ ...PASSING, measured: "absent", outcome: "fail" }] }),
      },
    ]);
    expect(found).toEqual([]);
  });
});

describe("checker command", () => {
  const checker = fileURLToPath(new URL("./check-evidence.ts", import.meta.url));

  async function run(record: EvidenceRecord): Promise<{ code: number; stderr: string; stdout: string }> {
    const dir = await mkdtemp(join(tmpdir(), "omp-evidence-"));
    try {
      const ledgerPath = join(dir, "LEDGER.md");
      const recordPath = join(dir, "record.json");
      await writeFile(ledgerPath, LEDGER);
      await writeFile(recordPath, JSON.stringify(record, undefined, 2));
      const child = Bun.spawn(["bun", checker, "--ledger", ledgerPath, recordPath], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("exits non-zero and prints the row, expectation and measured value", async () => {
    const { code, stderr } = await run(PERSISTENCE_BUG);
    expect(code).toBe(1);
    expect(stderr).toContain("disagreement on row: Linux host lifecycle");
    expect(stderr).toContain('expected: assertion "no session of class user" claims count 0');
    expect(stderr).toContain("measured: 1");
    expect(stderr).toContain("evidence check failed: 1 disagreement(s)");
  });

  test("exits zero when the evidence agrees", async () => {
    const { code, stdout } = await run(evidence());
    expect(code).toBe(0);
    expect(stdout).toContain("evidence check passed: 1 record(s) agree with 3 ledger rows");
  });
});
