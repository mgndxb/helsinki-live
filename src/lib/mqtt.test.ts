import { describe, expect, it } from "vitest";

import { connectPacket, encodeLength, PacketReader, parsePublish, subscribePacket } from "./mqtt";

const encoder = new TextEncoder();

function publish(topic: string, payload: string): Uint8Array {
  const t = encoder.encode(topic);
  const p = encoder.encode(payload);
  const body = [t.length >> 8, t.length & 0xff, ...t, ...p];
  return Uint8Array.from([0x30, ...encodeLength(body.length), ...body]);
}

describe("encodeLength", () => {
  it("matches the examples in the MQTT 3.1.1 spec", () => {
    expect(encodeLength(0)).toEqual([0x00]);
    expect(encodeLength(127)).toEqual([0x7f]);
    expect(encodeLength(128)).toEqual([0x80, 0x01]);
    expect(encodeLength(16_383)).toEqual([0xff, 0x7f]);
    expect(encodeLength(16_384)).toEqual([0x80, 0x80, 0x01]);
    expect(encodeLength(268_435_455)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });
});

describe("packets", () => {
  it("builds a CONNECT for protocol level 4 with a clean session", () => {
    const bytes = [...connectPacket("ab", 30)];
    expect(bytes).toEqual([0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30, 0, 2, 0x61, 0x62]);
  });

  it("builds a SUBSCRIBE with the reserved flags and QoS 0 per filter", () => {
    const bytes = [...subscribePacket(7, ["a/#"])];
    expect(bytes).toEqual([0x82, 8, 0, 7, 0, 3, 0x61, 0x2f, 0x23, 0]);
  });
});

describe("PacketReader", () => {
  it("reads several packets from one chunk", () => {
    const reader = new PacketReader();
    const chunk = Uint8Array.from([...publish("a", "1"), ...publish("b", "2")]);
    const packets = reader.push(chunk);
    expect(packets.map((p) => parsePublish(p).topic)).toEqual(["a", "b"]);
  });

  it("waits for the rest of a packet split across chunks", () => {
    const reader = new PacketReader();
    const whole = publish("/hfp/v2/journey/ongoing/vp/tram", '{"VP":{}}');
    expect(reader.push(whole.slice(0, 5))).toEqual([]);
    const packets = reader.push(whole.slice(5));
    expect(packets).toHaveLength(1);
    const { topic, payload } = parsePublish(packets[0]!);
    expect(topic).toBe("/hfp/v2/journey/ongoing/vp/tram");
    expect(new TextDecoder().decode(payload)).toBe('{"VP":{}}');
  });

  it("handles a split inside the length bytes of a large packet", () => {
    const reader = new PacketReader();
    const whole = publish("t", "x".repeat(300)); // remaining length needs two bytes
    expect(reader.push(whole.slice(0, 2))).toEqual([]);
    const packets = reader.push(whole.slice(2));
    expect(parsePublish(packets[0]!).payload).toHaveLength(300);
  });

  it("skips the packet id on QoS 1 messages", () => {
    const t = encoder.encode("q");
    const body = [0, t.length, ...t, 0x12, 0x34, 0x7b, 0x7d];
    const packets = new PacketReader().push(Uint8Array.from([0x32, body.length, ...body]));
    expect(new TextDecoder().decode(parsePublish(packets[0]!).payload)).toBe("{}");
  });
});
