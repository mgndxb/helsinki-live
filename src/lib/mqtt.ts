/**
 * A minimal MQTT 3.1.1 client over WebSocket: subscribe-only, QoS 0.
 *
 * HSL publishes every vehicle's position over MQTT. Reading it needs only a
 * handful of packet types, so this replaces a ~100 kB library with ~200 lines
 * that are easy to test byte for byte.
 */

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const UNSUBSCRIBE = 10;
const PINGREQ = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** MQTT's "remaining length": 7 bits per byte, high bit set while more bytes follow. */
export function encodeLength(length: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return bytes;
}

function utf8WithLength(text: string): number[] {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function packet(type: number, flags: number, body: number[]): Uint8Array {
  return Uint8Array.from([(type << 4) | flags, ...encodeLength(body.length), ...body]);
}

export function connectPacket(clientId: string, keepAliveSeconds: number): Uint8Array {
  const protocol = utf8WithLength("MQTT");
  const level = 4; // 3.1.1
  const cleanSession = 0x02;
  return packet(CONNECT, 0, [
    ...protocol,
    level,
    cleanSession,
    keepAliveSeconds >> 8,
    keepAliveSeconds & 0xff,
    ...utf8WithLength(clientId),
  ]);
}

export function subscribePacket(packetId: number, filters: string[]): Uint8Array {
  const body = [packetId >> 8, packetId & 0xff];
  for (const filter of filters) body.push(...utf8WithLength(filter), 0); // QoS 0
  return packet(SUBSCRIBE, 0b0010, body);
}

export function unsubscribePacket(packetId: number, filters: string[]): Uint8Array {
  const body = [packetId >> 8, packetId & 0xff];
  for (const filter of filters) body.push(...utf8WithLength(filter));
  return packet(UNSUBSCRIBE, 0b0010, body);
}

export const pingPacket = Uint8Array.of(PINGREQ << 4, 0);

export interface Packet {
  type: number;
  flags: number;
  body: Uint8Array;
}

/**
 * Splits a byte stream into packets. One WebSocket frame can hold several
 * packets or only part of one, so incomplete bytes wait for the next chunk.
 */
export class PacketReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Packet[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);

    const packets: Packet[] = [];
    let offset = 0;
    while (offset + 2 <= merged.length) {
      const header = merged[offset]!;
      let length = 0;
      let multiplier = 1;
      let cursor = offset + 1;
      let complete = false;
      while (cursor < merged.length && cursor - offset <= 4) {
        const byte = merged[cursor++]!;
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete || cursor + length > merged.length) break;
      packets.push({ type: header >> 4, flags: header & 0x0f, body: merged.slice(cursor, cursor + length) });
      offset = cursor + length;
    }
    this.buffer = merged.slice(offset);
    return packets;
  }
}

export function parsePublish({ flags, body }: Packet): { topic: string; payload: Uint8Array } {
  const topicLength = (body[0]! << 8) | body[1]!;
  const topic = decoder.decode(body.subarray(2, 2 + topicLength));
  const qos = (flags >> 1) & 0b11;
  const payloadStart = 2 + topicLength + (qos > 0 ? 2 : 0);
  return { topic, payload: body.subarray(payloadStart) };
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "paused";

interface ClientOptions {
  onMessage: (topic: string, payload: Uint8Array) => void;
  onStatus?: (status: ConnectionStatus) => void;
  keepAliveSeconds?: number;
}

/** Keeps one connection open, re-subscribes after reconnects, and backs off when the broker is unreachable. */
export class MqttClient {
  private socket: WebSocket | null = null;
  private reader = new PacketReader();
  private filters = new Set<string>();
  private nextPacketId = 1;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly url: string,
    private readonly options: ClientOptions,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.of(0xe0, 0)); // DISCONNECT
    socket?.close();
    this.options.onStatus?.("paused");
  }

  setFilters(next: string[]) {
    const wanted = new Set(next);
    const removed = [...this.filters].filter((filter) => !wanted.has(filter));
    const added = next.filter((filter) => !this.filters.has(filter));
    this.filters = wanted;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (removed.length) this.socket.send(unsubscribePacket(this.packetId(), removed));
    if (added.length) this.socket.send(subscribePacket(this.packetId(), added));
  }

  private packetId() {
    const id = this.nextPacketId;
    this.nextPacketId = id >= 0xffff ? 1 : id + 1;
    return id;
  }

  private open() {
    this.options.onStatus?.(this.attempts === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.url, "mqtt");
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.reader = new PacketReader();
    const keepAlive = this.options.keepAliveSeconds ?? 30;

    socket.onopen = () => {
      const clientId = `helsinki-live-${Math.random().toString(36).slice(2, 10)}`;
      socket.send(connectPacket(clientId, keepAlive));
    };

    socket.onmessage = (event) => {
      for (const packet of this.reader.push(new Uint8Array(event.data as ArrayBuffer))) {
        if (packet.type === PUBLISH) {
          const { topic, payload } = parsePublish(packet);
          this.options.onMessage(topic, payload);
        } else if (packet.type === CONNACK) {
          if (packet.body[1] !== 0) {
            socket.close();
            return;
          }
          this.attempts = 0;
          this.options.onStatus?.("live");
          if (this.filters.size) socket.send(subscribePacket(this.packetId(), [...this.filters]));
          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(pingPacket);
          }, keepAlive * 750);
        }
      }
    };

    socket.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.stopped || this.socket !== socket) return;
      this.attempts += 1;
      const delay = Math.min(15_000, 1_000 * 2 ** (this.attempts - 1));
      this.options.onStatus?.("reconnecting");
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }
}
