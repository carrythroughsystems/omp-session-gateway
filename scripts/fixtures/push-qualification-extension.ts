import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Structural subset of the documented OMP 18.3.0 extension API; no private OMP imports. */
interface Context {
  readonly hasUI: boolean;
  readonly sessionManager: { getSessionId(): string };
  readonly ui: { select(title: string, choices: string[], options: { signal: AbortSignal }): Promise<string | undefined> };
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
  newSession(): Promise<{ cancelled: boolean }>;
}
interface ExtensionApi {
  registerCommand(name: string, command: { description: string; handler(args: string, context: Context): Promise<void> }): void;
  on(name: "before_agent_start", handler: (event: unknown, context: Context) => Promise<void>): void;
  sendUserMessage(message: string): void;
  setSessionName(name: string): Promise<void>;
}

export const PUSH_FIXTURE_ASK_TITLE = "Qualification input canary";
export const PUSH_FIXTURE_ASK_BODY = "Qualification answer canary";
export const PUSH_FIXTURE_SESSION_NAME = "Push qualification session";
export const PUSH_FIXTURE_COMMANDS = ["ask", "answer", "busy", "release", "replace", "stop"] as const;
export type PushFixtureCommand = (typeof PUSH_FIXTURE_COMMANDS)[number];
export interface FixtureCommand { readonly sequence: number; readonly operation: PushFixtureCommand; readonly expectedSessionId?: string }

export function parseFixtureCommand(value: unknown, epoch: string, previous: number): FixtureCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid fixture command");
  const record = value as Record<string, unknown>;
  const guarded = record.expectedSessionId !== undefined;
  if (Object.keys(record).sort().join(",") !== (guarded ? "epoch,expectedSessionId,operation,sequence" : "epoch,operation,sequence") || record.epoch !== epoch ||
    typeof record.sequence !== "number" || !Number.isSafeInteger(record.sequence) || record.sequence <= previous ||
    !PUSH_FIXTURE_COMMANDS.includes(record.operation as PushFixtureCommand) ||
    guarded && (record.operation !== "ask" || typeof record.expectedSessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(record.expectedSessionId))) throw new Error("invalid fixture command");
  return { sequence: record.sequence, operation: record.operation as PushFixtureCommand,
    ...(guarded ? { expectedSessionId: record.expectedSessionId as string } : {}) };
}

/** Explicitly loaded only into an owned fixture. Control files are NOT discovery files. */
export default function pushQualificationExtension(api: ExtensionApi): void {
  const root = process.env.OMP_PUSH_FIXTURE_ROOT;
  const epoch = process.env.OMP_PUSH_FIXTURE_EPOCH;
  if (root === undefined || epoch === undefined || !/^[0-9a-f-]{36}$/u.test(epoch)) throw new Error("qualification fixture requires an owned control directory");
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let ask: AbortController | undefined;
  let sequence = 0;
  let previousCommand: string | undefined;
  let running = false;
  let sessionId: (() => string) | undefined;
  const acknowledge = async (phase: "ready" | "accepted" | "settled" | "failed"): Promise<void> => {
    const path = join(root, "ack.json");
    await writeFile(`${path}.tmp`, JSON.stringify({ epoch, sequence, phase, sessionId: sessionId?.() }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  api.on("before_agent_start", async (_event, context) => {
    if (hold === undefined) throw new Error("qualification fixture refuses unarmed provider work");
    await hold;
    // Abort during documented prompt preparation: the synthetic key never reaches a provider.
    context.abort();
    hold = undefined;
    release = undefined;
  });
  api.registerCommand("push-qualification", {
    description: "Run the explicitly armed disposable Push qualification fixture",
    async handler(_args, context) {
      if (running || !context.hasUI) throw new Error("qualification fixture requires one interactive owner");
      running = true;
      sessionId = () => context.sessionManager.getSessionId();
      await api.setSessionName(PUSH_FIXTURE_SESSION_NAME);
      await acknowledge("ready");
      while (running) {
        await Bun.sleep(100);
        const path = join(root, "command.json");
        let raw: string;
        try {
          const metadata = await stat(path);
          if (metadata.size > 1_024 || (metadata.mode & 0o077) !== 0) throw new Error("unsafe fixture command");
          raw = await readFile(path, "utf8");
        } catch (error) {
          const filesystemError = error as NodeJS.ErrnoException;
          if (filesystemError.code === "ENOENT") continue;
          await acknowledge("failed");
          break;
        }
        let command: FixtureCommand;
        try {
          if (raw === previousCommand) continue;
          const value: unknown = JSON.parse(raw);
          command = parseFixtureCommand(value, epoch, sequence);
        } catch {
          await acknowledge("failed");
          break;
        }
        sequence = command.sequence;
        previousCommand = raw;
        try {
          switch (command.operation) {
            case "ask": {
              if (ask !== undefined || !context.isIdle()) throw new Error("fixture is not idle");
              if (command.expectedSessionId !== undefined && context.sessionManager.getSessionId() !== command.expectedSessionId) {
                throw new Error("fixture session changed before ask");
              }
              const controller = new AbortController();
              ask = controller;
              void context.ui.select(PUSH_FIXTURE_ASK_TITLE, [PUSH_FIXTURE_ASK_BODY], { signal: controller.signal })
                .then(() => { if (ask === controller) ask = undefined; }, () => { running = false; });
              break;
            }
            case "answer":
              ask?.abort();
              ask = undefined;
              break;
            case "busy":
              if (ask !== undefined || !context.isIdle() || hold !== undefined) throw new Error("fixture is not idle");
              { const gate = Promise.withResolvers<void>(); hold = gate.promise; release = gate.resolve; }
              api.sendUserMessage("Qualification benign activity canary");
              break;
            case "release":
              release?.();
              break;
            case "replace":
              if (ask !== undefined || !context.isIdle() || hold !== undefined) throw new Error("fixture is not idle");
              if ((await context.newSession()).cancelled) throw new Error("fixture replacement cancelled");
              await api.setSessionName(PUSH_FIXTURE_SESSION_NAME);
              break;
            case "stop":
              ask?.abort();
              release?.();
              running = false;
              await acknowledge("settled");
              context.shutdown();
              return;
          }
          await acknowledge("accepted");
        } catch {
          await acknowledge("failed");
          break;
        }
      }
      ask?.abort();
      release?.();
      context.shutdown();
    },
  });
}
