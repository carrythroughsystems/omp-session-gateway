import { describe, expect, test } from "bun:test";
import * as wire from "@oh-my-pi/pi-wire";
import { importRoomKey, open, seal } from "../upstream/src/lib/codec";
import { formatCollabLink, packEnvelope, parseCollabLink, rewriteEnvelopePeer, unpackEnvelope } from "../upstream/src/lib/link";
import { asStrictBytes } from "../upstream/src/vendor/pi-utils/bytes";

describe("upstream wire and pure byte helper", () => {
  test("reuses shared envelope functions and preserves offset payload views", () => {
    expect(packEnvelope).toBe(wire.packEnvelope);
    expect(unpackEnvelope).toBe(wire.unpackEnvelope);
    expect(rewriteEnvelopePeer).toBe(wire.rewriteEnvelopePeer);
    const frame = packEnvelope(0x12345678, new Uint8Array([11, 22, 33]));
    expect([...frame]).toEqual([0x12, 0x34, 0x56, 0x78, 11, 22, 33]);
    const backing = new Uint8Array(frame.length + 8);
    backing.set(frame, 3);
    const offset = backing.subarray(3, 3 + frame.length);
    rewriteEnvelopePeer(offset, 7);
    const parsed = unpackEnvelope(offset)!;
    expect(parsed.peerId).toBe(7);
    expect([...parsed.payload]).toEqual([11, 22, 33]);
    expect(parsed.payload.buffer).toBe(backing.buffer);
    expect(unpackEnvelope(new Uint8Array(3))).toBeNull();
  });

  test("copies sliced and shared buffers but reuses whole ArrayBuffers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(asStrictBytes(bytes)).toBe(bytes);
    for (const view of [bytes.subarray(1), new Uint8Array(new SharedArrayBuffer(2)).fill(9)]) {
      const strict = asStrictBytes(view);
      expect(strict.buffer).toBeInstanceOf(ArrayBuffer);
      expect(strict.buffer).not.toBe(view.buffer);
      expect(strict.byteOffset).toBe(0);
      expect(strict.byteLength).toBe(strict.buffer.byteLength);
      expect([...strict]).toEqual([...view]);
    }
  });

  test("round-trips offset encrypted health and acknowledgement frames", async () => {
    const raw = new Uint8Array(40).fill(1).subarray(4, 36);
    const key = await importRoomKey(raw);
    for (const frame of [{ t: "gateway-health-ping", seq: 1 }, { t: "gateway-health-pong", seq: 1 }, { t: "ui-request-end", reqId: 7 }]) {
      const encrypted = await seal(key, frame);
      const backing = new Uint8Array(encrypted.length + 8);
      backing.set(encrypted, 3);
      // Gateway health frames extend the upstream WireFrame type returned by open.
      const decoded: unknown = await open(key, backing.subarray(3, 3 + encrypted.length));
      expect(decoded).toEqual(frame);
      encrypted[encrypted.length - 1]! ^= 1;
      await expect(open(key, encrypted)).rejects.toThrow();
    }
    await expect(open(key, new Uint8Array(12))).rejects.toThrow("Sealed frame too short");
  });

  test("omits writeToken for View and preserves it for Control", () => {
    const key = new Uint8Array(32).fill(1);
    const token = new Uint8Array(16).fill(2);
    for (const writeToken of [undefined, token]) {
      const parsed = parseCollabLink(formatCollabLink("wss://relay.example", "synthetic-room", key, writeToken));
      expect("error" in parsed).toBeFalse();
      if ("error" in parsed) throw new Error("synthetic link rejected");
      expect(parsed.key).toEqual(key);
      expect(Object.hasOwn(parsed, "writeToken")).toBe(writeToken !== undefined);
      expect(parsed.writeToken).toEqual(writeToken);
    }
  });
});
