import { EMPTY_FLEET_WORKER_STATE, type FleetWorkerState } from "@omp-session-gateway/protocol";

/** Only the reducer's bounded identifiers and counters enter this database, never push bodies. */
export class FleetWorkerStore {
  private memory: FleetWorkerState = EMPTY_FLEET_WORKER_STATE;
  private loaded = false;
  private database: Promise<IDBDatabase | undefined> | undefined;

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly time: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
  ) {}

  private open(): Promise<IDBDatabase | undefined> {
    if (this.database !== undefined) return this.database;
    if (this.factory === undefined) return this.database = Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<IDBDatabase | undefined>();
    this.database = promise;
    let settled = false;
    const finish = (database?: IDBDatabase): void => {
      if (settled) { database?.close(); return; }
      settled = true;
      this.time.clearTimeout(timeout);
      resolve(database);
    };
    const timeout = this.time.setTimeout(() => finish(), 2_000);
    try {
      const request = this.factory.open("omp-notification-ordering", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("state"); };
      request.onerror = () => finish();
      request.onblocked = () => finish();
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); this.database = Promise.resolve(undefined); };
        finish(database);
      };
    } catch { finish(); }
    return promise;
  }

  async read(): Promise<FleetWorkerState> {
    if (this.loaded) return this.memory;
    const database = await this.open();
    if (database !== undefined) {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<FleetWorkerState | undefined>();
        const transaction = database.transaction("state", "readonly");
        const request = transaction.objectStore("state").get("worker");
        // This store has one versioned, worker-owned record, written only from the shared reducer.
        transaction.oncomplete = () => resolve(request.result as FleetWorkerState | undefined);
        transaction.onerror = transaction.onabort = () => reject(new Error("worker state unavailable"));
        const saved = await promise;
        // Existing installations predate the bounded fresh-snapshot request map.
        if (saved !== undefined) this.memory = { ...saved, observed: saved.observed ?? {} };
      } catch { this.database = Promise.resolve(undefined); database.close(); }
    }
    this.loaded = true;
    return this.memory;
  }

  async write(state: FleetWorkerState, requireDurable = false): Promise<boolean> {
    const database = await this.open();
    let committed = false;
    if (database !== undefined) {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const transaction = database.transaction("state", "readwrite");
        transaction.objectStore("state").put(state, "worker");
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(new Error("worker state unavailable"));
        await promise;
        committed = true;
      } catch { this.database = Promise.resolve(undefined); database.close(); }
    }
    // Pushes retain their in-worker fallback; an uncommitted mode change must not take effect.
    if (committed || !requireDurable) {
      this.memory = state;
      this.loaded = true;
    }
    return committed;
  }
}
