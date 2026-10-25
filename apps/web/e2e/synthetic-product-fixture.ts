import type { BrowserContext } from "@playwright/test";
import type { SessionMetadata } from "../../../packages/protocol/src/index.ts";

export const FIXED_NOW = "2026-08-21T12:10:00.000Z";

export function syntheticSession(
  instanceId: string,
  title: string,
  cwdLabel: string,
  startedAt: string,
  lastSeenAt: string,
  attention?: { readonly requestId: string; readonly since: string; readonly preview: string },
): SessionMetadata {
  return {
    instanceId,
    generation: 1,
    title,
    cwdLabel,
    startedAt,
    lastSeenAt,
    canView: true,
    canControl: true,
    inputRequired: attention !== undefined,
    ...(attention === undefined
      ? {}
      : {
          ask: {
            requestId: attention.requestId,
            since: attention.since,
            preview: attention.preview,
            optionCount: 2,
          },
        }),
  };
}

export const RELEASE_WORKING = syntheticSession(
  "media-release-qual-0002",
  "Release qualification",
  "omp-session-gateway",
  "2026-08-21T11:50:00.000Z",
  "2026-08-21T12:09:58.000Z",
);
export const ANDROID_WORKING = syntheticSession(
  "media-android-soak-0003",
  "Android reconnect soak",
  "omp-session-gateway",
  "2026-08-21T11:40:00.000Z",
  "2026-08-21T12:09:57.000Z",
);
export const DOCS_WORKING = syntheticSession(
  "media-docs-examples-0004",
  "Docs & examples",
  "omp-session-gateway",
  "2026-08-21T11:30:00.000Z",
  "2026-08-21T12:09:56.000Z",
);
export const UPSTREAM_WORKING = syntheticSession(
  "media-upstream-compat-0005",
  "Upstream compatibility",
  "oh-my-pi",
  "2026-08-21T11:20:00.000Z",
  "2026-08-21T12:09:55.000Z",
);
export const INITIAL_SESSIONS = [RELEASE_WORKING, ANDROID_WORKING, DOCS_WORKING, UPSTREAM_WORKING] as const;
export const GATEWAY_WORKING = syntheticSession(
  "media-gateway-auth-0001",
  "Gateway auth hardening",
  "omp-session-gateway",
  "2026-08-21T12:00:00.000Z",
  "2026-08-21T12:09:59.000Z",
);
export const GATEWAY_WAITING = syntheticSession(
  "media-gateway-auth-0001",
  "Gateway auth hardening",
  "omp-session-gateway",
  "2026-08-21T12:00:00.000Z",
  "2026-08-21T12:09:59.000Z",
  {
    requestId: "media-request-auth-0001",
    since: "2026-08-21T12:05:00.000Z",
    preview: "How should ADR-0036 proceed?",
  },
);
export const RELEASE_WAITING = syntheticSession(
  "media-release-qual-0002",
  "Release qualification",
  "omp-session-gateway",
  "2026-08-21T11:50:00.000Z",
  "2026-08-21T12:09:58.000Z",
  {
    requestId: "media-request-release-0002",
    since: "2026-08-21T12:07:00.000Z",
    preview: "Approve the synthetic qualification record?",
  },
);

/** Defaults preserve the canonical README capture's frame ordering and content. */
export async function installSyntheticProductFixture(
  context: BrowserContext,
  roomKey: Uint8Array,
  options: {
    readonly readOnly?: boolean;
    readonly transcript?: string;
    readonly randomSeed?: number;
    readonly historyEntryCount?: number;
    readonly streamedTranscript?: string;
    readonly answerRequests?: boolean;
    /** Leave the snapshot open so a test can deliver chunks through the live socket. */
    readonly manualSnapshot?: boolean;
    /** Ordinary Control composer without the canonical Ask, for draft-only flows. */
    readonly activeAsk?: boolean;
  } = {},
): Promise<void> {
  await context.addInitScript(
    ({ fixedNow, keyBytes, readOnly, transcript, randomSeed, historyEntryCount, streamedTranscript, answerRequests, manualSnapshot, activeAsk }) => {
      const fixedEpoch = new Date(fixedNow).getTime();
      const NativeDate = Date;
      class FixedDate extends NativeDate {
        constructor(value?: string | number | Date) {
          if (arguments.length === 0) super(fixedEpoch);
          else super(value as string | number);
        }

        static override now(): number {
          return fixedEpoch;
        }
      }
      Object.defineProperty(globalThis, "Date", { configurable: true, value: FixedDate });
      // README defaults stay constant. Percy needs unique element IDs, so visual runs use a
      // fixed-seed sequence instead of giving every input/dialog the same serializer UID.
      let seed = randomSeed ?? 0;
      Math.random = randomSeed === undefined ? () => 0.5 : () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 0x1_0000_0000;
      };

      const notificationState = {
        permission: "default" as NotificationPermission,
        permissionRequests: 0,
        subscribeCalls: 0,
        subscriptionActive: false,
        unsubscribeCalls: 0,
      };
      const subscriptionJson = {
        endpoint: "https://push.example.test/send/canonical-media",
        expirationTime: null,
        keys: { p256dh: "P".repeat(88), auth: "A".repeat(22) },
      };
      let subscription: PushSubscription | null = null;
      const createSubscription = (): PushSubscription => ({
        endpoint: subscriptionJson.endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey(): ArrayBuffer | null {
          return null;
        },
        async unsubscribe(): Promise<boolean> {
          notificationState.unsubscribeCalls += 1;
          notificationState.subscriptionActive = false;
          subscription = null;
          return true;
        },
        toJSON(): PushSubscriptionJSON {
          return structuredClone(subscriptionJson);
        },
      });
      const pushManager = {
        async getSubscription(): Promise<PushSubscription | null> {
          return subscription;
        },
        async subscribe(): Promise<PushSubscription> {
          notificationState.subscribeCalls += 1;
          notificationState.subscriptionActive = true;
          subscription = createSubscription();
          return subscription;
        },
      };
      Object.defineProperty(globalThis, "__ompNotificationMedia", {
        configurable: true,
        value: notificationState,
      });
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: class {
          static get permission(): NotificationPermission {
            return notificationState.permission;
          }

          static async requestPermission(): Promise<NotificationPermission> {
            notificationState.permissionRequests += 1;
            notificationState.permission = "granted";
            return notificationState.permission;
          }
        },
      });
      Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
      if (typeof ServiceWorkerRegistration !== "undefined") {
        Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
          configurable: true,
          get(): typeof pushManager {
            return pushManager;
          },
        });
        Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", {
          configurable: true,
          async value(): Promise<void> {},
        });
      }

      const question = "How should ADR-0036 proceed?";
      const options = [
        {
          label: "Implement ADR-0036 locally",
          description: "Apply the compatibility fix in the gateway worktree.",
        },
        {
          label: "Wait for upstream",
          description: "Leave the current behavior unchanged.",
        },
      ];
      const askArguments = {
        questions: [{ id: "adr-0036", question, options, multi: false, recommended: 0 }],
      };
      const encryptionKey = crypto.subtle.importKey(
        "raw",
        new Uint8Array(keyBytes),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      const encoder = new TextEncoder();
      const guestFrameCounts = { prompts: 0, responses: 0 };
      Object.defineProperty(globalThis, "__ompSyntheticGuestCounts", { configurable: true, value: guestFrameCounts });

      class AskWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readyState = AskWebSocket.CONNECTING;
        binaryType: BinaryType = "arraybuffer";
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        sentWelcome = false;
        snapshotEntries: unknown[] = [];
        snapshotOffset = 0;

        constructor(url: string) {
          this.url = url;
          const counters = globalThis as typeof globalThis & { __ompRelaySocketCount?: number };
          counters.__ompRelaySocketCount = (counters.__ompRelaySocketCount ?? 0) + 1;
          // Tests drive further host frames (a later Ask, its end) through the live socket.
          Object.defineProperty(globalThis, "__ompSyntheticSocket", { configurable: true, value: this });
          queueMicrotask(() => {
            this.readyState = AskWebSocket.OPEN;
            this.onopen?.(new Event("open"));
          });
        }

        close(): void {
          this.readyState = AskWebSocket.CLOSED;
        }

        disconnect(): void {
          this.readyState = AskWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close", { code: 1006 }));
        }

        async sendSnapshotChunk(count: number, final = false): Promise<void> {
          const entries = this.snapshotEntries.slice(this.snapshotOffset, this.snapshotOffset + count);
          this.snapshotOffset += entries.length;
          await this.sendHostFrame({ t: "snapshot-chunk", entries, final });
        }

        send(data: ArrayBuffer | ArrayBufferView): void {
          if (this.sentWelcome) {
            void this.receiveGuestFrame(data);
            return;
          }
          this.sentWelcome = true;
          void this.sendHostFrames();
        }

        async receiveGuestFrame(data: ArrayBuffer | ArrayBufferView): Promise<void> {
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.slice(4, 16) }, await encryptionKey, bytes.slice(16),
          );
          const frame = JSON.parse(new TextDecoder().decode(plaintext));
          if (frame.t === "prompt") {
            guestFrameCounts.prompts += 1;
          }
          if (frame.t === "ui-response") {
            guestFrameCounts.responses += 1;
          }
          if (!answerRequests || frame.t !== "ui-response" || frame.reqId !== 7 || readOnly) return;
          await this.sendHostFrame({ t: "ui-request-end", reqId: 7 });
          await this.sendHostFrame({
            t: "event",
            event: { type: "tool_execution_end", toolCallId: "media-ask-active", toolName: "ask",
              result: { content: [{ type: "text", text: "answered" }] }, isError: false },
          });
          await this.sendHostFrame({
            t: "entry",
            entry: {
              id: "synthetic-answer", parentId: null, timestamp: fixedNow, type: "message",
              message: { role: "user", content: `Synthetic Ask answered: ${String(frame.value)}`, timestamp: fixedEpoch },
            },
          });
        }

        async sendHostFrame(frame: unknown): Promise<void> {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              await encryptionKey,
              encoder.encode(JSON.stringify(frame)),
            ),
          );
          const envelope = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
          new DataView(envelope.buffer).setUint32(0, 1, false);
          envelope.set(iv, 4);
          envelope.set(ciphertext, 4 + iv.byteLength);
          this.onmessage?.(new MessageEvent("message", { data: envelope.buffer }));
        }

        async sendHostFrames(): Promise<void> {
          const assistantEntry = {
            id: "media-ask-entry",
            parentId: null,
            timestamp: "2026-08-21T12:05:00.000Z",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "media-ask-active", name: "ask", arguments: askArguments }],
              model: "fixture/model",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 0,
            },
          };
          const entries = transcript === undefined ? [assistantEntry] : [
            {
              ...assistantEntry,
              id: "visual-prose-entry",
              message: {
                ...assistantEntry.message,
                content: [{ type: "text", text: transcript }],
                stopReason: "stop",
              },
            },
            ...(readOnly || !activeAsk ? [] : [assistantEntry]),
          ];
          entries.unshift(...Array.from({ length: historyEntryCount }, (_, index) => ({
            ...assistantEntry,
            id: `synthetic-history-${index}`,
            message: {
              ...assistantEntry.message,
              content: [{ type: "text", text: `Synthetic earlier entry ${index}` }],
              stopReason: "stop",
            },
          })));
          this.snapshotEntries = entries;
          const frames = [
            {
              t: "welcome",
              proto: 3,
              header: {
                type: "session",
                id: "media-collab-session",
                title: "Gateway auth hardening",
                timestamp: "2026-08-21T12:00:00.000Z",
                cwd: "omp-session-gateway",
              },
              state: {
                isStreaming: true,
                queuedMessageCount: 0,
                cwd: "omp-session-gateway",
                participants: [{ name: "host", role: "host" }],
              },
              agents: [],
              entryCount: entries.length,
              readOnly,
            },
            ...(manualSnapshot ? [] : [{ t: "snapshot-chunk", entries, final: true }]),
            { t: "gateway-health-pong", seq: 0 },
            {
              t: "event",
              event: {
                type: "tool_execution_start",
                toolCallId: "media-ask-active",
                toolName: "ask",
                args: askArguments,
              },
            },
            {
              t: "ui-request",
              request: {
                reqId: 7,
                kind: "select",
                title: question,
                options,
                initialIndex: 0,
                selectionMarker: "radio",
              },
            },
          ];
          const initialFrameCount = manualSnapshot ? 2 : 3;
          for (const frame of readOnly || !activeAsk ? frames.slice(0, initialFrameCount) : frames) await this.sendHostFrame(frame);
          if (streamedTranscript !== undefined) {
            for (let end = 1; end <= streamedTranscript.length; end += 7) {
              await this.sendHostFrame({
                t: "event",
                event: {
                  type: "message_update",
                  message: { ...assistantEntry.message, content: [{ type: "text", text: streamedTranscript.slice(0, end) }], stopReason: "stop" },
                },
              });
              await new Promise(resolve => setTimeout(resolve, 5));
            }
            await this.sendHostFrame({
              t: "event",
              event: {
                type: "message_update",
                message: { ...assistantEntry.message, content: [{ type: "text", text: streamedTranscript }], stopReason: "stop" },
              },
            });
          }
        }
      }
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: AskWebSocket });
    },
    {
      fixedNow: FIXED_NOW, keyBytes: [...roomKey], readOnly: options.readOnly ?? false,
      transcript: options.transcript, randomSeed: options.randomSeed,
      historyEntryCount: options.historyEntryCount ?? 0, streamedTranscript: options.streamedTranscript,
      answerRequests: options.answerRequests ?? false,
      manualSnapshot: options.manualSnapshot ?? false, activeAsk: options.activeAsk ?? true,
    },
  );
}

