import { describe, expect, spyOn, test } from "bun:test";
import { JOURNEY_VIEW_STATE, LEAK_SINKS, runCollaborationJourney, vendorLeakControlExpression, type JourneyPage } from "./browser-journey.ts";

describe("vendor-safe application asset attestation", () => {
  test.each([undefined, "/assets/app.abc123.js"])("compares the expected asset in-page without returning a pathname to the vendor (expected=%s)", async expected => {
    const loggedResults: unknown[] = [];
    const page: JourneyPage = {
      navigate: async () => {},
      evaluate: async <T>(expression: string): Promise<T> => {
        let result: unknown = true;
        if (expression === JOURNEY_VIEW_STATE) result = { readOnly: true, controlVisible: true, rootMounted: true };
        else if (expression.includes("sendInitiallyDisabled")) result = { writable: true, sendInitiallyDisabled: true };
        else if (expression.includes('getEntriesByType("resource")') && !expression.includes("serviceWorker")) {
          result = new Function("performance", `return ${expression};`)({
            getEntriesByType: () => [{ name: "https://fixture.invalid/assets/app.abc123.js" }],
          });
        }
        loggedResults.push(result);
        return result as T;
      },
    };
    const result = await runCollaborationJourney(page, { origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-EXPECTED-ASSET", ...(expected === undefined ? {} : { expectedAppAsset: expected }) });
    expect(result.appAsset).toBe(expected);
    expect(loggedResults.some(value => typeof value === "string")).toBe(false);
    expect(JSON.stringify(loggedResults)).not.toContain("/assets/");
  });

  test("refuses an asset mismatch in-page before any capability opens", async () => {
    let viewOpened = false;
    const page: JourneyPage = {
      navigate: async () => {},
      evaluate: async <T>(expression: string): Promise<T> => {
        if (expression.includes('getEntriesByType("resource")') && !expression.includes("serviceWorker")) {
          return new Function("performance", `return ${expression};`)({
            getEntriesByType: () => [{ name: "https://fixture.invalid/assets/app.def456.js" }],
          }) as T;
        }
        return true as T;
      },
    };
    await expect(runCollaborationJourney(page, {
      origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-EXPECTED-ASSET", expectedAppAsset: "/assets/app.abc123.js",
      announce: stage => { if (stage === "View") viewOpened = true; },
    })).rejects.toThrow("installed app asset does not match the release archive");
    expect(viewOpened).toBe(false);
  });
  const SHELL_CODES = [
    "no-registration", "sw-installing", "sw-waiting", "sw-not-active", "uncontrolled", "controller-not-active",
    "no-app-asset", "asset-mismatch", "shell-caches:0", "shell-caches:2", "asset-not-cached", "ready-late", "evaluation-error",
  ] as const;
  test.each([...SHELL_CODES])("installed-shell timeout returns only the closed diagnostic %s", async code => {
    const marker = "SYNTHETIC_PAGE_DETAIL_NOT_FOR_ERRORS";
    let diagnosticReads = 0, readinessReads = 0;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      const worker = (state: string) => ({ state, scriptURL: marker });
      const registration = code === "no-registration" ? undefined : {
        installing: code === "sw-installing" ? worker("installing") : null,
        waiting: code === "sw-waiting" ? worker("installed") : null,
        active: worker(code === "sw-not-active" ? "activating" : "activated"),
      };
      const controller = code === "uncontrolled" ? null : worker(code === "controller-not-active" ? "activating" : "activated");
      const page: JourneyPage = {
        navigate: async () => {},
        evaluate: async <T>(expression: string): Promise<T> => {
          if (!expression.includes('"no-app-asset"')) { readinessReads += 1; return false as T; }
          diagnosticReads += 1;
          return await new Function("performance", "caches", "navigator", `return ${expression};`)({
            getEntriesByType: () => code === "no-app-asset" ? [] : [{
              name: `https://fixture.invalid/assets/app.${code === "asset-mismatch" ? "def456" : "abc123"}.js?${marker}`,
            }],
          }, {
            keys: async () => {
              if (code === "evaluation-error") throw new Error(marker);
              const count = code === "shell-caches:0" ? 0 : code === "shell-caches:2" ? 2 : 1;
              return [marker, ...Array.from({ length: count }, (_, index) => `omp-sessions-shell-${marker}-${index}`)];
            },
            open: async () => ({ match: async () => code === "asset-not-cached" ? undefined : new Response(marker) }),
          }, { serviceWorker: { controller, getRegistration: async () => registration } }) as T;
        },
      };
      const error = await runCollaborationJourney(page, {
        origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT", expectedAppAsset: "/assets/app.abc123.js",
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`installed application shell did not become ready (${code}; 0 of 120 reads failed)`);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(marker);
      expect(diagnosticReads).toBe(1);
      expect(readinessReads).toBe(120);
    } finally { timer.mockRestore(); }
  });
  test("installed-shell timeout counts readiness reads that failed rather than returned false", async () => {
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      let reads = 0;
      const page: JourneyPage = {
        navigate: async () => {},
        evaluate: async <T>(expression: string): Promise<T> => {
          if (expression.includes('"no-app-asset"')) return "ready-late" as T;
          reads += 1;
          if (reads % 2 === 0) throw new Error("SYNTHETIC_SCRIPT_FAILURE_DETAIL");
          return false as T;
        },
      };
      const error = await runCollaborationJourney(page, {
        origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT",
      }).catch((error: unknown) => error);
      expect((error as Error).message).toBe("installed application shell did not become ready (ready-late; 60 of 120 reads failed)");
      expect(String(error)).not.toContain("SYNTHETIC_SCRIPT_FAILURE_DETAIL");
    } finally { timer.mockRestore(); }
  });
  test.each(["untrusted result", "transport error"])("installed-shell diagnostics discard page-controlled %s", async failure => {
    const marker = "SYNTHETIC_PAGE_RESULT_NOT_A_DIAGNOSTIC";
    let diagnosticReads = 0;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      const page: JourneyPage = {
        navigate: async () => {},
        evaluate: async <T>(expression: string): Promise<T> => {
          if (!expression.includes('"no-app-asset"')) return false as T;
          diagnosticReads += 1;
          if (failure === "transport error") throw new Error(marker);
          return marker as T;
        },
      };
      const error = await runCollaborationJourney(page, {
        origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT",
      }).catch((error: unknown) => error);
      expect((error as Error).message).toBe("installed application shell did not become ready (evaluation-error; 0 of 120 reads failed)");
      expect(String(error)).not.toContain(marker);
      expect((error as Error).cause).toBeUndefined();
      expect(diagnosticReads).toBe(1);
    } finally { timer.mockRestore(); }
  });
});

async function control(residual: boolean) {
  const store = () => {
    const values = new Map<string, string>();
    return {
      get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { if (!residual) values.delete(key); },
    };
  };
  const location = { pathname: "/", hash: "", search: "", href: "https://fixture.invalid/" };
  const history = { state: null as unknown, replaceState: (state: unknown, _title: string, path: string) => {
    if (residual && path === "/") return;
    history.state = state; location.hash = path.includes("#") ? path.slice(path.indexOf("#")) : "";
  } };
  const caches = new Map<string, Map<string, Response>>();
  const databases = new Map<string, Map<string, unknown>>();
  const asyncResult = (result: unknown) => {
    const request: { result: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = { result };
    queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  };
  const indexedDB = {
    databases: async () => [...databases.keys()].map(name => ({ name })), deleteDatabase: (name: string) => { if (!residual) databases.delete(name); },
    open: (name: string) => {
      let values = databases.get(name);
      if (values === undefined) { values = new Map(); databases.set(name, values); }
      const entries = values;
      return asyncResult({
        objectStoreNames: ["s"], createObjectStore: () => {}, close: () => {},
        transaction: () => {
          const tx: { oncomplete?: () => void; objectStore: () => object } = {
            objectStore: () => ({ put: (value: unknown, key: string) => { entries.set(key, value); queueMicrotask(() => tx.oncomplete?.()); }, getAll: () => asyncResult([...entries.values()]) }),
          };
          return tx;
        },
      });
    },
  };
  let cookie = "";
  const document = {
    get cookie() { return cookie; }, set cookie(value: string) { cookie = value.includes("expires=") && !residual ? "" : value; },
    referrer: "", documentElement: { outerHTML: "<html></html>" },
  };
  const evaluate = new Function("localStorage", "sessionStorage", "document", "caches", "indexedDB", "history", "location", "performance", "navigator", "Request", `return ${vendorLeakControlExpression()};`);
  class PageRequest { constructor(readonly url: string) {} }
  return evaluate(store(), store(), document, {
    keys: async () => [...caches.keys(), "SYNTHETIC-PRIVATE-CACHE-NAME"],
    open: async (name: string) => {
      let values = caches.get(name); if (values === undefined) { values = new Map(); caches.set(name, values); }
      const entries = values;
      return { put: async (request: PageRequest, response: Response) => { entries.set(request.url, response); }, keys: async () => [...entries.keys()].map(url => ({ url })), match: async (request: PageRequest) => entries.get(request.url) };
    },
    delete: async (name: string) => { if (!residual) caches.delete(name); },
  }, indexedDB, history, location, { getEntriesByType: () => [] }, { serviceWorker: { getRegistration: async () => ({}) } }, PageRequest);
}

describe("vendor-safe synthetic sink control", () => {
  test.each([false, true])("never returns residual values or cache names when residual=%s", async residual => {
    const result = await control(residual);
    expect(Object.keys(result).sort()).toEqual(["complete", "detected", "missedCount", "residualCount"]);
    expect(result.complete).toBe(true);
    expect(result.detected).toEqual(LEAK_SINKS);
    expect(result.missedCount).toBe(0);
    expect(result.residualCount).toBe(residual ? 5 : 0);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-");
  });
});
