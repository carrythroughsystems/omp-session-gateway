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
        else if (expression.includes("serviceWorker")) result = "ready";
        else if (expression.includes('getEntriesByType("resource")')) {
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
    // Only the closed shell state may be a string; no pathname ever reaches a vendor-logged result.
    expect(loggedResults.some(value => typeof value === "string" && value !== "ready")).toBe(false);
    expect(JSON.stringify(loggedResults)).not.toContain("/assets/");
  });

  test("refuses an asset mismatch in-page before any capability opens", async () => {
    let viewOpened = false;
    const page: JourneyPage = {
      navigate: async () => {},
      evaluate: async <T>(expression: string): Promise<T> => {
        if (expression.includes("serviceWorker")) return "ready" as T;
        if (expression.includes('getEntriesByType("resource")')) {
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
    "no-registration", "sw-installing", "sw-waiting", "sw-no-active", "sw-activating", "sw-active-other", "uncontrolled",
    "controller-not-active", "no-app-asset", "asset-mismatch", "shell-caches:0", "shell-caches:2", "asset-not-cached", "evaluation-error",
  ] as const;
  const immediateTimers = () => spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  /** Evaluates the real state expression against a page whose installed shell is stuck at `code`. */
  const stuckPage = (code: (typeof SHELL_CODES)[number] | "ready", marker: string) => {
    const worker = (state: string) => ({ state, scriptURL: marker });
    const registration = code === "no-registration" ? undefined : {
      installing: code === "sw-installing" ? worker("installing") : null,
      waiting: code === "sw-waiting" ? worker("installed") : null,
      active: code === "sw-no-active" ? null : worker(code === "sw-activating" ? "activating" : code === "sw-active-other" ? "redundant" : "activated"),
    };
    const controller = code === "uncontrolled" ? null : worker(code === "controller-not-active" ? "activating" : "activated");
    return (expression: string): Promise<unknown> => new Function("performance", "caches", "navigator", `return ${expression};`)({
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
    }, { serviceWorker: { controller, getRegistration: async () => registration } });
  };
  test.each([...SHELL_CODES])("a shell stuck at %s times out naming only that closed state", async code => {
    const marker = "SYNTHETIC_PAGE_DETAIL_NOT_FOR_ERRORS";
    const timer = immediateTimers();
    try {
      let reads = 0;
      const state = stuckPage(code, marker);
      const page: JourneyPage = {
        navigate: async () => {},
        evaluate: async <T>(expression: string): Promise<T> => { reads += 1; return await state(expression) as T; },
      };
      const error = await runCollaborationJourney(page, {
        origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT", expectedAppAsset: "/assets/app.abc123.js",
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`installed application shell did not become ready (${code}; 0 of 120 reads failed)`);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(marker);
      expect(reads).toBe(120);
    } finally { timer.mockRestore(); }
  });
  test("a shell that settles proceeds, and a stalled one reports the distinct states it passed through", async () => {
    const timer = immediateTimers();
    try {
      const progression = (stages: readonly ((typeof SHELL_CODES)[number] | "ready")[]) => {
        let reads = 0;
        const page: JourneyPage = {
          navigate: async () => {},
          evaluate: async <T>(expression: string): Promise<T> => {
            if (!expression.includes("serviceWorker")) throw new Error("stop after the installed shell");
            reads += 1;
            // Every read fails transiently once in ten; the rest walk through the stages, ten reads each.
            if (reads % 10 === 0) throw new Error("SYNTHETIC_SCRIPT_FAILURE_DETAIL");
            return await stuckPage(stages[Math.min(Math.floor(reads / 10), stages.length - 1)]!, "SYNTHETIC")(expression) as T;
          },
        };
        return runCollaborationJourney(page, { origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT" })
          .catch((error: unknown) => (error as Error).message);
      };
      expect(await progression(["sw-installing", "sw-activating", "uncontrolled", "ready"])).not.toContain("installed application shell");
      const stalled = await progression(["sw-installing", "sw-activating"]);
      expect(stalled).toBe("installed application shell did not become ready (sw-installing>sw-activating; 12 of 120 reads failed)");
      expect(stalled).not.toContain("SYNTHETIC_SCRIPT_FAILURE_DETAIL");
    } finally { timer.mockRestore(); }
  });
  test.each(["untrusted result", "transport error"])("installed-shell states discard a page-controlled %s", async failure => {
    const marker = "SYNTHETIC_PAGE_RESULT_NOT_A_DIAGNOSTIC";
    const timer = immediateTimers();
    try {
      const page: JourneyPage = {
        navigate: async () => {},
        evaluate: async <T>(): Promise<T> => {
          if (failure === "transport error") throw new Error(marker);
          return marker as T;
        },
      };
      const error = await runCollaborationJourney(page, {
        origin: "https://fixture.invalid", label: "fixture", promptMarker: "SYNTHETIC-SHELL-TIMEOUT",
      }).catch((error: unknown) => error);
      expect((error as Error).message).toBe(failure === "transport error"
        ? "installed application shell did not become ready (no state; 120 of 120 reads failed)"
        : "installed application shell did not become ready (evaluation-error; 0 of 120 reads failed)");
      expect(String(error)).not.toContain(marker);
      expect((error as Error).cause).toBeUndefined();
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
