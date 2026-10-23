import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Retire only this failed campaign after its driver proves settled cleanup and
 * durably records that proof. BEGIN EXCLUSIVE refuses any live holder; neither
 * the database inode nor a foreign owner is ever replaced. An absent row is a
 * replay of a completed clear, not permission to run the proof against a new owner.
 */
export async function clearReleaseHostLease(
  owner: string,
  proveAndRecordCleanup: () => Promise<void>,
  directory = join(homedir(), ".local", "state", "omp-session-gateway", "release-host"),
): Promise<"cleared" | "absent"> {
  if (!owner) throw new Error("release host lease requires a campaign identity");
  const parent = lstatSync(directory), path = join(directory, "lease.sqlite"), file = lstatSync(path);
  if (!parent.isDirectory() || !file.isFile() || [parent, file].some(info =>
    info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error("release host lease must be private and owned by the release account");
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    database.exec("BEGIN EXCLUSIVE");
    const previous = database.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get();
    if (previous === null) { database.exec("COMMIT"); return "absent"; }
    if (previous.owner !== owner) throw new Error("release host lease owner changed; maintainer recovery required");
    await proveAndRecordCleanup();
    if (database.query("DELETE FROM campaign WHERE id = 1 AND owner = ?").run(owner).changes !== 1) throw new Error("release host lease owner was not cleared");
    database.exec("COMMIT");
    return "cleared";
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    if (error !== null && typeof error === "object" && "code" in error && error.code === "SQLITE_BUSY") throw new Error("release host is busy; another campaign holds its lease");
    throw error;
  } finally { database.close(); }
}

/**
 * One release account owns the retained host and Pixel, across tags and checkouts.
 * SQLite's EXCLUSIVE locking mode retains the OS lock across commits. Committing
 * the owner before effects makes crash recovery belong to that same campaign;
 * neither an expired timestamp nor a dead/reused PID can steal a live lock.
 * Never unlink this database: doing so would create a second lock inode.
 */
export async function withReleaseHostLease<T>(
  owner: string,
  action: () => Promise<T>,
  directory = join(homedir(), ".local", "state", "omp-session-gateway", "release-host"),
): Promise<T> {
  if (owner.length === 0) throw new Error("release host lease requires a campaign identity");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new Error("release host lease directory must be private and owned by the release account");
  }
  const path = join(directory, "lease.sqlite");
  try {
    // Do not open/close an existing database outside SQLite: POSIX close() can
    // release locks held by another SQLite connection in this same process.
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
  } catch (error) {
    if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) {
    throw new Error("release host lease must be a private current-user regular file");
  }

  const database = new Database(path);
  try {
    try {
      // Reserve the writer before enabling retained exclusive locking. Starting
      // two EXCLUSIVE-mode readers first can deadlock their lock upgrades. One
      // statement per exec: Bun ignores a busy BEGIN followed by more statements.
      database.exec("PRAGMA busy_timeout = 1000");
      database.exec("BEGIN IMMEDIATE");
      database.exec("PRAGMA locking_mode = EXCLUSIVE");
      database.exec("CREATE TABLE IF NOT EXISTS campaign (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL)");
      const previous = database.query<{ owner: string }, []>("SELECT owner FROM campaign WHERE id = 1").get();
      if (previous !== null && previous.owner !== owner) {
        throw new Error("release host requires recovery by its previous campaign; resume that exact command first");
      }
      database.query("INSERT OR REPLACE INTO campaign (id, owner) VALUES (1, ?)").run(owner);
      database.exec("COMMIT");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "SQLITE_BUSY") {
        throw new Error("release host is busy; another campaign holds its lease");
      }
      throw error;
    }
    const result = await action();
    database.exec("BEGIN EXCLUSIVE");
    database.exec("DELETE FROM campaign");
    database.exec("COMMIT");
    return result;
  } finally {
    // A thrown action retains the committed owner, not a live OS lock. Only that
    // campaign can resume its existing receipts/cleanup after failure or SIGKILL.
    database.close();
  }
}
