import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type {
  BlockTransformState,
  ClientWsMessage,
  OnlineRoomState,
  ServerWsMessage,
  SfxEventType,
} from '../../shared/jengaProtocol';
import { MqttWssClient } from './mqttWssClient';
import { P2PRoomHost } from './p2pRoomHost';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface OnlineClientCallbacks {
  onStatusChange: (status: ConnectionStatus) => void;
  onJoined: (playerId: string, room: OnlineRoomState, blocks: BlockTransformState[]) => void;
  onRoomState: (room: OnlineRoomState) => void;
  onPhysicsFull: (blocks: BlockTransformState[]) => void;
  onPhysicsDelta: (blocks: BlockTransformState[]) => void;
  onSfx: (sfx: SfxEventType, intensity?: number) => void;
  onError: (message: string) => void;
  onHostClosed?: (reason: string) => void;
}

interface WssEnvelope {
  senderId: string;
  msg: ClientWsMessage;
}

const PLAYER_ID_KEY = 'kigumi_online_player_id_v1';
const ROOM_PEER_PREFIX = 'kigumi-jenga-room-';
const WSS_TOPIC_PREFIX = 'kigumi/jenga/v1';

const PEER_OPTIONS: PeerOptions = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

export function getOrCreateClientPlayerId(): string {
  try {
    const existing = sessionStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const created = `u_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(PLAYER_ID_KEY, created);
    return created;
  } catch {
    return `u_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function randomRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export class OnlineJengaClient {
  private callbacks: OnlineClientCallbacks;
  private playerId: string;
  private peer: Peer | null = null;
  private mqtt: MqttWssClient | null = null;
  private hostRoom: P2PRoomHost | null = null;
  private guestConns = new Map<string, DataConnection>();
  private wssGuests = new Map<string, number>(); // playerId -> lastSeenAt
  private hostConn: DataConnection | null = null;
  private guestTransport: 'none' | 'webrtc' | 'wss' = 'none';
  private activeRoomCode: string | null = null;
  private activePlayerName = 'プレイヤー';
  private joinedAsGuest = false;
  private intentionalClose = false;

  private joinTimeout: number | null = null;
  private wssFallbackTimer: number | null = null;
  private hostReadyTimer: number | null = null;
  private pingTimer: number | null = null;
  private wssSweepTimer: number | null = null;

  private handleVisibilityChange = (): void => {
    if (document.hidden || this.intentionalClose) return;
    if (this.peer && this.peer.disconnected && !this.peer.destroyed) {
      try {
        this.peer.reconnect();
      } catch {
        // Ignore reconnect errors
      }
    }
    this.mqtt?.ensureActive();
  };

  constructor(callbacks: OnlineClientCallbacks) {
    this.callbacks = callbacks;
    this.playerId = getOrCreateClientPlayerId();
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  public getPlayerId(): string {
    return this.playerId;
  }

  private clearTimers(): void {
    if (this.joinTimeout !== null) {
      window.clearTimeout(this.joinTimeout);
      this.joinTimeout = null;
    }
    if (this.wssFallbackTimer !== null) {
      window.clearTimeout(this.wssFallbackTimer);
      this.wssFallbackTimer = null;
    }
    if (this.hostReadyTimer !== null) {
      window.clearTimeout(this.hostReadyTimer);
      this.hostReadyTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.wssSweepTimer !== null) {
      window.clearInterval(this.wssSweepTimer);
      this.wssSweepTimer = null;
    }
  }

  private cleanupTransport(): void {
    this.clearTimers();
    this.joinedAsGuest = false;
    this.guestTransport = 'none';
    this.activeRoomCode = null;
    this.wssGuests.clear();

    if (this.hostRoom) {
      this.hostRoom.dispose();
      this.hostRoom = null;
    }

    for (const conn of this.guestConns.values()) {
      try {
        conn.close();
      } catch {
        // Ignore
      }
    }
    this.guestConns.clear();

    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch {
        // Ignore
      }
      this.hostConn = null;
    }

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignore
      }
      this.peer = null;
    }

    if (this.mqtt) {
      this.mqtt.dispose();
      this.mqtt = null;
    }
  }

  private handleServerMessage(msg: ServerWsMessage, sourceTransport?: 'webrtc' | 'wss'): void {
    switch (msg.type) {
      case 'room:joined':
        if (this.joinedAsGuest && sourceTransport && this.guestTransport !== sourceTransport) {
          return;
        }
        this.clearJoinTimeout();
        if (this.wssFallbackTimer !== null) {
          window.clearTimeout(this.wssFallbackTimer);
          this.wssFallbackTimer = null;
        }
        this.joinedAsGuest = true;
        if (sourceTransport) {
          this.guestTransport = sourceTransport;
          if (sourceTransport === 'webrtc' && this.mqtt) {
            this.mqtt.dispose();
            this.mqtt = null;
          } else if (sourceTransport === 'wss' && this.peer) {
            try {
              this.peer.destroy();
            } catch {
              // Ignore
            }
            this.peer = null;
            this.hostConn = null;
          }
        }
        this.activeRoomCode = msg.room.roomCode;
        this.callbacks.onStatusChange('connected');
        this.callbacks.onJoined(msg.playerId, msg.room, msg.blocks);
        break;

      case 'room:state':
        this.callbacks.onRoomState(msg.room);
        break;

      case 'room:error':
        this.clearJoinTimeout();
        if (this.joinedAsGuest) {
          const reason = msg.message;
          this.intentionalClose = true;
          this.cleanupTransport();
          this.callbacks.onStatusChange('disconnected');
          this.callbacks.onHostClosed?.(reason);
        } else {
          this.cleanupTransport();
          this.callbacks.onStatusChange('disconnected');
          this.callbacks.onError(msg.message);
        }
        break;

      case 'physics:full':
        this.callbacks.onPhysicsFull(msg.blocks);
        break;

      case 'physics:delta':
        this.callbacks.onPhysicsDelta(msg.blocks);
        break;

      case 'sfx:event':
        this.callbacks.onSfx(msg.sfx, msg.intensity);
        break;

      case 'pong':
        break;
    }
  }

  private clearJoinTimeout(): void {
    if (this.joinTimeout !== null) {
      window.clearTimeout(this.joinTimeout);
      this.joinTimeout = null;
    }
  }

  public createRoom(playerName: string): void {
    this.intentionalClose = false;
    this.cleanupTransport();
    this.activePlayerName = playerName.trim() || 'ホスト';
    this.callbacks.onStatusChange('connecting');
    this.startHostWithCode(randomRoomCode(), 0);
  }

  private startHostWithCode(code: string, attempt: number): void {
    if (this.intentionalClose) return;

    let lobbyOpened = false;
    const c2hTopic = `${WSS_TOPIC_PREFIX}/${code}/c2h`;
    const bcastTopic = `${WSS_TOPIC_PREFIX}/${code}/bcast`;

    const ensureRoomReady = () => {
      if (lobbyOpened || this.intentionalClose) return;
      lobbyOpened = true;
      if (this.hostReadyTimer !== null) {
        window.clearTimeout(this.hostReadyTimer);
        this.hostReadyTimer = null;
      }
      this.activeRoomCode = code;

      const room = new P2PRoomHost(code, this.playerId, this.activePlayerName, {
        onSendToPlayer: (targetId, msg) => {
          const conn = this.guestConns.get(targetId);
          if (conn && conn.open) {
            conn.send(msg);
          } else if (this.wssGuests.has(targetId) && this.mqtt?.isConnected()) {
            this.mqtt.publish(`${WSS_TOPIC_PREFIX}/${code}/u/${targetId}`, JSON.stringify(msg));
          }
        },
        onBroadcastRemote: (msg) => {
          for (const [gid, conn] of this.guestConns.entries()) {
            if (conn.open) {
              conn.send(msg);
            } else if (!this.wssGuests.has(gid)) {
              // Wait for reconnect
            }
          }
          if (this.wssGuests.size > 0 && this.mqtt?.isConnected()) {
            this.mqtt.publish(bcastTopic, JSON.stringify(msg));
          }
        },
        onLocalEvent: (msg) => {
          this.handleServerMessage(msg);
        },
      });

      this.hostRoom = room;
      this.wssSweepTimer = window.setInterval(() => {
        if (!this.hostRoom) return;
        const now = Date.now();
        for (const [gid, lastSeen] of this.wssGuests.entries()) {
          if (now - lastSeen > 26000) {
            this.wssGuests.delete(gid);
            this.hostRoom.handleGuestDisconnect(gid);
          }
        }
      }, 6000);

      this.callbacks.onStatusChange('connected');
      this.callbacks.onJoined(this.playerId, room.getRoomState(), room.getBlocksSnapshot());
    };

    // 1. Start MQTT-WSS relay listener for guaranteed NAT traversal fallback
    const mqtt = new MqttWssClient(`kigumi_h_${code}`, {
      onConnect: () => {
        if (this.mqtt !== mqtt || this.intentionalClose) return;
        mqtt.subscribe(c2hTopic);
        ensureRoomReady();
      },
      onMessage: (_topic, payload) => {
        if (this.mqtt !== mqtt || !this.hostRoom) return;
        let env: WssEnvelope;
        try {
          env = JSON.parse(payload) as WssEnvelope;
        } catch {
          return;
        }
        if (!env || !env.senderId || !env.msg) return;

        const { senderId, msg } = env;
        this.wssGuests.set(senderId, Date.now());

        if (msg.type === 'ping') return;

        if (msg.type === 'room:join') {
          const res = this.hostRoom.addOrReconnectGuest(msg.playerId, msg.playerName);
          if (!res.ok) {
            this.wssGuests.delete(msg.playerId);
            mqtt.publish(
              `${WSS_TOPIC_PREFIX}/${code}/u/${msg.playerId}`,
              JSON.stringify({ type: 'room:error', message: res.message } satisfies ServerWsMessage)
            );
            return;
          }

          mqtt.publish(
            `${WSS_TOPIC_PREFIX}/${code}/u/${msg.playerId}`,
            JSON.stringify({
              type: 'room:joined',
              playerId: msg.playerId,
              room: this.hostRoom.getRoomState(),
              blocks: this.hostRoom.getBlocksSnapshot(),
            } satisfies ServerWsMessage)
          );
          this.hostRoom.broadcastRoomState();
          return;
        }

        if (msg.type === 'room:leave') {
          this.wssGuests.delete(senderId);
          this.hostRoom.removeGuest(senderId);
          return;
        }

        this.hostRoom.handleMessage(senderId, msg);
      },
      onDisconnect: () => {
        // MqttWssClient auto-reconnects
      },
    });
    this.mqtt = mqtt;

    // 2. Also start PeerJS WebRTC Host Peer for direct low-latency P2P when NAT permits
    const peer = new Peer(`${ROOM_PEER_PREFIX}${code}`, PEER_OPTIONS);
    this.peer = peer;

    this.hostReadyTimer = window.setTimeout(() => {
      if (!lobbyOpened && !this.intentionalClose) {
        if (mqtt.isConnected()) {
          ensureRoomReady();
        } else {
          this.cleanupTransport();
          this.callbacks.onStatusChange('disconnected');
          this.callbacks.onError(
            'ルームの作成がタイムアウトしました。通信環境をご確認のうえ再度お試しください。'
          );
        }
      }
    }, 8000);

    peer.on('open', () => {
      if (this.peer !== peer || this.intentionalClose) return;
      ensureRoomReady();
    });

    peer.on('disconnected', () => {
      if (this.peer === peer && !this.intentionalClose && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {
          // Ignore
        }
      }
    });

    peer.on('connection', (conn) => {
      let boundPlayerId: string | null = null;

      conn.on('data', (raw) => {
        const msg = raw as ClientWsMessage;
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

        if (msg.type === 'ping') {
          if (conn.open) conn.send({ type: 'pong' } satisfies ServerWsMessage);
          return;
        }

        if (!this.hostRoom) return;

        if (msg.type === 'room:join') {
          const res = this.hostRoom.addOrReconnectGuest(msg.playerId, msg.playerName);
          if (!res.ok) {
            if (conn.open) {
              conn.send({ type: 'room:error', message: res.message } satisfies ServerWsMessage);
            }
            window.setTimeout(() => {
              try {
                conn.close();
              } catch {
                // Ignore
              }
            }, 150);
            return;
          }

          boundPlayerId = msg.playerId;
          this.guestConns.set(msg.playerId, conn);

          if (conn.open) {
            conn.send({
              type: 'room:joined',
              playerId: msg.playerId,
              room: this.hostRoom.getRoomState(),
              blocks: this.hostRoom.getBlocksSnapshot(),
            } satisfies ServerWsMessage);
          }
          this.hostRoom.broadcastRoomState();
          return;
        }

        if (msg.type === 'room:leave') {
          if (boundPlayerId) {
            const leftId = boundPlayerId;
            boundPlayerId = null;
            this.guestConns.delete(leftId);
            this.hostRoom.removeGuest(leftId);
          }
          return;
        }

        if (boundPlayerId) {
          this.hostRoom.handleMessage(boundPlayerId, msg);
        }
      });

      conn.on('close', () => {
        if (boundPlayerId && this.guestConns.get(boundPlayerId) === conn) {
          this.guestConns.delete(boundPlayerId);
          this.hostRoom?.handleGuestDisconnect(boundPlayerId);
        }
      });

      conn.on('error', () => {
        if (boundPlayerId && this.guestConns.get(boundPlayerId) === conn) {
          this.guestConns.delete(boundPlayerId);
          this.hostRoom?.handleGuestDisconnect(boundPlayerId);
        }
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer || this.intentionalClose) return;
      const errType = (err as { type?: string })?.type;

      if (!lobbyOpened && errType === 'unavailable-id' && attempt < 5) {
        this.cleanupTransport();
        this.startHostWithCode(randomRoomCode(), attempt + 1);
        return;
      }
      // If PeerJS fails but MQTT-WSS is alive, host continues seamlessly over WSS relay
    });
  }

  public joinRoom(roomCode: string, playerName: string): void {
    const cleanCode = roomCode.replace(/\D/g, '').slice(0, 4);
    if (cleanCode.length !== 4) {
      this.callbacks.onError('4桁のルームコードを入力してください。');
      return;
    }

    this.intentionalClose = false;
    this.cleanupTransport();
    this.activePlayerName = playerName.trim() || 'プレイヤー';
    this.activeRoomCode = cleanCode;
    this.callbacks.onStatusChange('connecting');

    const c2hTopic = `${WSS_TOPIC_PREFIX}/${cleanCode}/c2h`;
    const uTopic = `${WSS_TOPIC_PREFIX}/${cleanCode}/u/${this.playerId}`;
    const bcastTopic = `${WSS_TOPIC_PREFIX}/${cleanCode}/bcast`;
    let wssJoinSent = false;
    let wssFallbackTriggered = false;

    const sendWssJoin = () => {
      wssFallbackTriggered = true;
      if (wssJoinSent || this.joinedAsGuest || this.intentionalClose) return;
      if (!this.mqtt?.isConnected()) return;
      wssJoinSent = true;
      const env: WssEnvelope = {
        senderId: this.playerId,
        msg: {
          type: 'room:join',
          roomCode: cleanCode,
          playerId: this.playerId,
          playerName: this.activePlayerName,
        },
      };
      this.mqtt.publish(c2hTopic, JSON.stringify(env));

      if (this.pingTimer === null) {
        this.pingTimer = window.setInterval(() => {
          if (this.guestTransport === 'wss' && this.mqtt?.isConnected()) {
            this.mqtt.publish(
              c2hTopic,
              JSON.stringify({ senderId: this.playerId, msg: { type: 'ping' } } satisfies WssEnvelope)
            );
          }
        }, 10000);
      }
    };

    // Overall timeout if neither direct P2P nor WSS relay finds an active host
    this.joinTimeout = window.setTimeout(() => {
      if (!this.joinedAsGuest && !this.intentionalClose) {
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        this.callbacks.onError(
          'ルームが見つからないか、ホストに接続できませんでした。4桁のコードを確認してください。'
        );
      }
    }, 11000);

    // Prepare MQTT-WSS fallback immediately (takes ~300ms to connect & subscribe)
    const mqtt = new MqttWssClient(`kigumi_g_${this.playerId}`, {
      onConnect: () => {
        if (this.mqtt !== mqtt || this.intentionalClose) return;
        mqtt.subscribe(uTopic);
        mqtt.subscribe(bcastTopic);
        if (wssFallbackTriggered && !this.joinedAsGuest) {
          sendWssJoin();
        }
      },
      onMessage: (_topic, payload) => {
        if (this.mqtt !== mqtt || this.intentionalClose) return;
        let msg: ServerWsMessage;
        try {
          msg = JSON.parse(payload) as ServerWsMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        if (this.guestTransport === 'webrtc') return;
        this.handleServerMessage(msg, 'wss');
      },
      onDisconnect: () => {
        // Auto-reconnects
      },
    });
    this.mqtt = mqtt;

    // Race WebRTC direct P2P for 2.2s; if NAT blocks direct P2P, switch smoothly to WSS relay
    this.wssFallbackTimer = window.setTimeout(() => {
      this.wssFallbackTimer = null;
      if (!this.joinedAsGuest && !this.intentionalClose) {
        sendWssJoin();
      }
    }, 2200);

    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer || this.intentionalClose || this.joinedAsGuest) return;

      const conn = peer.connect(`${ROOM_PEER_PREFIX}${cleanCode}`, {
        reliable: true,
        serialization: 'json',
      });
      this.hostConn = conn;

      conn.on('open', () => {
        if (this.hostConn !== conn || this.intentionalClose || this.joinedAsGuest) return;
        conn.send({
          type: 'room:join',
          roomCode: cleanCode,
          playerId: this.playerId,
          playerName: this.activePlayerName,
        } satisfies ClientWsMessage);

        if (this.pingTimer === null) {
          this.pingTimer = window.setInterval(() => {
            if (this.guestTransport === 'webrtc' && conn.open) {
              conn.send({ type: 'ping' } satisfies ClientWsMessage);
            }
          }, 12000);
        }
      });

      conn.on('data', (raw) => {
        if (this.hostConn !== conn || this.intentionalClose) return;
        const msg = raw as ServerWsMessage;
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        if (this.guestTransport === 'wss') return;
        this.handleServerMessage(msg, 'webrtc');
      });

      conn.on('close', () => {
        if (this.hostConn !== conn || this.guestTransport !== 'webrtc') return;
        this.clearTimers();
        const wasJoined = this.joinedAsGuest;
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        if (!this.intentionalClose && wasJoined) {
          this.callbacks.onHostClosed?.('ホストとのP2P接続が終了しました。');
        }
      });

      conn.on('error', () => {
        if (this.hostConn !== conn || this.intentionalClose || this.joinedAsGuest) return;
        // Immediate fallback to WSS
        try {
          peer.destroy();
        } catch {
          // Ignore
        }
        this.peer = null;
        this.hostConn = null;
        sendWssJoin();
      });
    });

    peer.on('error', () => {
      if (this.peer !== peer || this.intentionalClose || this.joinedAsGuest) return;
      try {
        peer.destroy();
      } catch {
        // Ignore
      }
      this.peer = null;
      this.hostConn = null;
      sendWssJoin();
    });
  }

  public send(msg: ClientWsMessage): void {
    if (this.hostRoom) {
      this.hostRoom.handleMessage(this.playerId, msg);
      return;
    }
    if (this.guestTransport === 'webrtc' && this.hostConn && this.hostConn.open) {
      this.hostConn.send(msg);
      return;
    }
    if (this.guestTransport === 'wss' && this.mqtt && this.activeRoomCode) {
      const env: WssEnvelope = { senderId: this.playerId, msg };
      this.mqtt.publish(`${WSS_TOPIC_PREFIX}/${this.activeRoomCode}/c2h`, JSON.stringify(env));
    }
  }

  public leaveRoom(): void {
    this.intentionalClose = true;

    if (this.hostRoom) {
      const closeMsg: ServerWsMessage = {
        type: 'room:error',
        message: 'ホストがルームを退出しました。',
      };
      for (const conn of this.guestConns.values()) {
        if (conn.open) {
          try {
            conn.send(closeMsg);
          } catch {
            // Ignore
          }
        }
      }
      if (this.wssGuests.size > 0 && this.mqtt?.isConnected() && this.activeRoomCode) {
        this.mqtt.publish(`${WSS_TOPIC_PREFIX}/${this.activeRoomCode}/bcast`, JSON.stringify(closeMsg));
      }
    } else if (this.guestTransport === 'webrtc' && this.hostConn && this.hostConn.open) {
      try {
        this.hostConn.send({
          type: 'room:leave',
          roomCode: this.activeRoomCode ?? '',
        } satisfies ClientWsMessage);
      } catch {
        // Ignore
      }
    } else if (this.guestTransport === 'wss' && this.mqtt?.isConnected() && this.activeRoomCode) {
      this.mqtt.publish(
        `${WSS_TOPIC_PREFIX}/${this.activeRoomCode}/c2h`,
        JSON.stringify({
          senderId: this.playerId,
          msg: { type: 'room:leave', roomCode: this.activeRoomCode },
        } satisfies WssEnvelope)
      );
    }

    this.cleanupTransport();
    this.callbacks.onStatusChange('disconnected');
  }

  public dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.leaveRoom();
  }
}
