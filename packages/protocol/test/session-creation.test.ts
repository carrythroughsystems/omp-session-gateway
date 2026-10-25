import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  parseJsonFrame, parseSessionCreationOptions, parseSessionCreationRequest,
  parseSessionCreationReceipt, parseSessionCreationStatus, ProtocolValidationError,
  SESSION_CREATION_ERRORS, SESSION_CREATION_STATES,
} from "../src/index.ts";

const uuid = "11111111-2222-4333-8444-555555555555";
const request = { clientOperationId: uuid, revision: uuid, projectId: "local", workingCopyId: "main", profileId: "omp" };
const choice = { id: "local", label: "Example" };
const options = { version: 1, revision: uuid, available: true,
  projects: [{ ...choice, workingCopies: [choice] }], profiles: [choice] };
const status = { operationId: uuid, state: "accepted", updatedAt: "2026-10-24T00:00:00.000Z" };
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const schemas = await Promise.all(["options", "request", "status"].map(async (name) =>
  ajv.compile(await Bun.file(new URL(`../../../schemas/session-creation-${name}.schema.json`, import.meta.url)).json())));

describe("session creation public contract", () => {
  test("validates all state-dependent public variants against parsers and schemas", () => {
    expect(parseSessionCreationRequest(request)).toEqual(request);
    expect(schemas[1]!(request)).toBe(true);
    for (const value of [options, ...["not_configured", "tern_unavailable", "configuration_unavailable", "ledger_unavailable"]
      .map((reason) => ({ version: 1, revision: uuid, available: false, reason, projects: [], profiles: [] }))]) {
      expect<unknown>(parseSessionCreationOptions(value)).toEqual(value);
      expect(schemas[0]!(value)).toBe(true);
    }
    for (const state of SESSION_CREATION_STATES) {
      expect(parseSessionCreationReceipt({ operationId: uuid, state })).toEqual({ operationId: uuid, state });
      const errors = SESSION_CREATION_ERRORS[state as keyof typeof SESSION_CREATION_ERRORS];
      for (const error of errors ?? [undefined]) {
        const value = { ...status, state, ...(error === undefined ? {} : { error }),
          ...(state === "ready" ? { session: { instanceId: "instance-test", generation: 1 } } : {}) };
        expect<unknown>(parseSessionCreationStatus(value)).toEqual(value);
        expect(schemas[2]!(value)).toBe(true);
      }
    }
  });

  test("rejects missing, unknown, null, aliased UUID and execution-bearing request fields", () => {
    for (const key of Object.keys(request)) {
      const value = { ...request } as Record<string, unknown>;
      delete value[key];
      expect(() => parseSessionCreationRequest(value)).toThrow(ProtocolValidationError);
      expect(schemas[1]!(value)).toBe(false);
    }
    for (const patch of [{ argv: ["SYNTHETIC_ARG_SECRET"] }, { projectId: "A" }, { profileId: null },
      { clientOperationId: uuid.toUpperCase().replace("11111111", "AAAAAAAA") },
      { revision: uuid.replace("-4333-", "-7333-") }, { workingCopyId: "x".repeat(33) }]) {
      const value = { ...request, ...patch };
      expect(() => parseSessionCreationRequest(value)).toThrow(ProtocolValidationError);
      expect(schemas[1]!(value)).toBe(false);
    }
    expect(() => parseJsonFrame(new TextEncoder().encode(`{"revision":"${uuid}","revision":"${uuid}"}`)))
      .toThrow(ProtocolValidationError);
    expect(() => parseSessionCreationRequest({ ...request, secret: "x".repeat(4096) })).toThrow(ProtocolValidationError);
  });

  test("enforces options collection bounds, uniqueness and fleet label normalization", () => {
    expect(parseSessionCreationOptions({ ...options, profiles: [{ id: "local", label: "  Cafe\u0301\u202e " }] }))
      .toMatchObject({ profiles: [{ id: "local", label: "Café" }] });
    for (const patch of [{ reason: "not_configured" }, { available: false }, { available: null },
      { projects: [] }, { profiles: [choice, choice] },
      { profiles: Array.from({ length: 9 }, (_, i) => ({ ...choice, id: `p${i}` })) },
      { projects: Array.from({ length: 17 }, (_, i) => ({ ...options.projects[0], id: `p${i}` })) },
      { projects: [{ ...options.projects[0], workingCopies: Array.from({ length: 9 }, (_, i) => ({ ...choice, id: `w${i}` })) }] },
      { profiles: [{ ...choice, label: "x".repeat(65) }] }, { profiles: [{ ...choice, path: "/SYNTHETIC_PATH_SECRET" }] }]) {
      expect(() => parseSessionCreationOptions({ ...options, ...patch })).toThrow(ProtocolValidationError);
    }
  });

  test("rejects forbidden status combinations, invalid dates and capability material", () => {
    for (const patch of [{ state: "ready" }, { state: "failed" }, { state: "outcome_unknown", error: "spawn_failed" },
      { state: "started_unavailable", error: "spawn_failed" }, { error: "interrupted" },
      { session: { instanceId: "instance-test", generation: 1 } }, { updatedAt: "tomorrow" },
      { capability: "CREATION_CAPABILITY_CANARY" }, { state: null }]) {
      const value = { ...status, ...patch };
      expect(() => parseSessionCreationStatus(value)).toThrow(ProtocolValidationError);
      expect(schemas[2]!(value)).toBe(false);
    }
    expect(() => parseSessionCreationStatus({ ...status, state: "ready",
      session: { instanceId: "instance-test", generation: 0 } })).toThrow(ProtocolValidationError);
    expect(() => parseSessionCreationReceipt({ operationId: uuid, state: "accepted", secret: true }))
      .toThrow(ProtocolValidationError);
  });
});
