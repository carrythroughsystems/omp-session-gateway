import { describe, expect, test } from "bun:test";
import { LEAK_SINKS, vendorLeakControlExpression } from "./browser-journey.ts";

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
