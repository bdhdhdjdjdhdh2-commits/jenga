const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeVarInt(len: number): number[] {
  const out: number[] = [];
  let x = len;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return out;
}

function toArrayBuffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function buildConnectPacket(clientId: string): ArrayBuffer {
  const idBytes = textEncoder.encode(clientId);
  const variableHeader = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x28]; // keepalive = 40s
  const payload = [idBytes.length >> 8, idBytes.length & 0xff, ...idBytes];
  const remLen = variableHeader.length + payload.length;
  return toArrayBuffer([0x10, ...encodeVarInt(remLen), ...variableHeader, ...payload]);
}

function buildSubscribePacket(packetId: number, topic: string): ArrayBuffer {
  const tBytes = textEncoder.encode(topic);
  const body = [
    packetId >> 8,
    packetId & 0xff,
    tBytes.length >> 8,
    tBytes.length & 0xff,
    ...tBytes,
    0x00,
  ];
  return toArrayBuffer([0x82, ...encodeVarInt(body.length), ...body]);
}

function buildPublishPacket(topic: string, payloadStr: string): ArrayBuffer {
  const tBytes = textEncoder.encode(topic);
  const pBytes = textEncoder.encode(payloadStr);
  const body = [tBytes.length >> 8, tBytes.length & 0xff, ...tBytes, ...pBytes];
  return toArrayBuffer([0x30, ...encodeVarInt(body.length), ...body]);
}

function buildPingPacket(): ArrayBuffer {
  return toArrayBuffer([0xc0, 0x00]);
}

export interface MqttWssCallbacks {
  onConnect: () => void;
  onMessage: (topic: string, payload: string) => void;
  onDisconnect: () => void;
}

export class MqttWssClient {
  private callbacks: MqttWssCallbacks;
  private clientId: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private disposed = false;
  private brokerIdx = 0;
  private nextPacketId = 1;
  private subscribedTopics = new Set<string>();
  private pendingPublishes: Array<{ topic: string; payload: string }> = [];
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private rxBuffer = new Uint8Array(0);

  constructor(clientId: string, callbacks: MqttWssCallbacks) {
    this.clientId = clientId;
    this.callbacks = callbacks;
    this.connect();
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public subscribe(topic: string): void {
    this.subscribedTopics.add(topic);
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const pid = this.nextPacketId++;
      if (this.nextPacketId > 65000) this.nextPacketId = 1;
      this.ws.send(buildSubscribePacket(pid, topic));
    }
  }

  public publish(topic: string, payload: string): void {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buildPublishPacket(topic, payload));
    } else if (!this.disposed) {
      if (this.pendingPublishes.length < 32) {
        this.pendingPublishes.push({ topic, payload });
      }
    }
  }

  public ensureActive(): void {
    if (this.disposed) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect();
    }
  }

  private connect(): void {
    if (this.disposed) return;

    const url = DEFAULT_BROKERS[this.brokerIdx % DEFAULT_BROKERS.length];
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ['mqtt']);
    } catch {
      this.scheduleReconnect();
      return;
    }

    socket.binaryType = 'arraybuffer';
    this.ws = socket;
    this.rxBuffer = new Uint8Array(0);

    const connectGuard = window.setTimeout(() => {
      if (this.ws === socket && !this.connected && !this.disposed) {
        try {
          socket.close();
        } catch {
          // Ignore
        }
      }
    }, 6000);

    socket.addEventListener('open', () => {
      if (this.ws !== socket || this.disposed) return;
      socket.send(buildConnectPacket(`${this.clientId}_${Math.random().toString(36).slice(2, 6)}`));
    });

    socket.addEventListener('message', (ev) => {
      if (this.ws !== socket || this.disposed) return;
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinaryChunk(new Uint8Array(ev.data), connectGuard);
      }
    });

    socket.addEventListener('close', () => {
      window.clearTimeout(connectGuard);
      if (this.ws !== socket) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.stopPing();
      if (wasConnected) {
        this.callbacks.onDisconnect();
      }
      if (!this.disposed) {
        this.brokerIdx = (this.brokerIdx + 1) % DEFAULT_BROKERS.length;
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      // Close event handles failover
    });
  }

  private handleBinaryChunk(chunk: Uint8Array, connectGuard: number): void {
    const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
    merged.set(this.rxBuffer, 0);
    merged.set(chunk, this.rxBuffer.length);
    this.rxBuffer = merged;

    let offset = 0;
    while (offset + 2 <= this.rxBuffer.length) {
      const header = this.rxBuffer[offset];
      const packetType = header >> 4;
      const qos = (header >> 1) & 0x03;

      // Decode MQTT variable-length remainingLength
      let multiplier = 1;
      let remLen = 0;
      let lenBytes = 0;
      let completeVarInt = false;

      for (let i = 1; i <= 4; i++) {
        if (offset + i >= this.rxBuffer.length) break;
        const encodedByte = this.rxBuffer[offset + i];
        remLen += (encodedByte & 127) * multiplier;
        multiplier *= 128;
        lenBytes++;
        if ((encodedByte & 128) === 0) {
          completeVarInt = true;
          break;
        }
      }

      if (!completeVarInt) break;
      const totalPacketLen = 1 + lenBytes + remLen;
      if (offset + totalPacketLen > this.rxBuffer.length) break;

      const bodyStart = offset + 1 + lenBytes;
      const bodyEnd = bodyStart + remLen;

      if (packetType === 2 && remLen >= 2) {
        // CONNACK
        window.clearTimeout(connectGuard);
        const rc = this.rxBuffer[bodyStart + 1];
        if (rc === 0) {
          this.connected = true;
          this.startPing();
          for (const topic of this.subscribedTopics) {
            const pid = this.nextPacketId++;
            if (this.nextPacketId > 65000) this.nextPacketId = 1;
            this.ws?.send(buildSubscribePacket(pid, topic));
          }
          while (this.pendingPublishes.length > 0) {
            const item = this.pendingPublishes.shift();
            if (item) {
              this.ws?.send(buildPublishPacket(item.topic, item.payload));
            }
          }
          this.callbacks.onConnect();
        }
      } else if (packetType === 3 && remLen >= 2) {
        // PUBLISH
        const topicLen = (this.rxBuffer[bodyStart] << 8) | this.rxBuffer[bodyStart + 1];
        const topicStart = bodyStart + 2;
        const topicEnd = topicStart + topicLen;
        if (topicEnd <= bodyEnd) {
          const topic = textDecoder.decode(this.rxBuffer.subarray(topicStart, topicEnd));
          let payloadStart = topicEnd;
          if (qos > 0) {
            payloadStart += 2;
          }
          if (payloadStart <= bodyEnd) {
            const payload = textDecoder.decode(this.rxBuffer.subarray(payloadStart, bodyEnd));
            this.callbacks.onMessage(topic, payload);
          }
        }
      }

      offset += totalPacketLen;
    }

    if (offset > 0) {
      this.rxBuffer = this.rxBuffer.slice(offset);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(buildPingPacket());
      }
    }, 20000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  public dispose(): void {
    this.disposed = true;
    this.connected = false;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.subscribedTopics.clear();
    this.pendingPublishes = [];
  }
}
