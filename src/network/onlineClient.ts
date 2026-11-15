import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type {
  BlockTransformState,
  ClientWsMessage,
  OnlineRoomState,
  ServerWsMessage,
  SfxEventType,
} from '../../shared/jengaProtocol';
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

const PLAYER_ID_KEY = 'kigumi_online_player_id_v1';
const ROOM_PEER_PREFIX = 'kigumi-jenga-room-';

const PEER_OPTIONS: PeerOptions = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
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
  private hostRoom: P2PRoomHost | null = null;
  private guestConns = new Map<string, DataConnection>();
  private hostConn: DataConnection | null = null;
  private activeRoomCode: string | null = null;
  private activePlayerName = 'プレイヤー';
  private joinedAsGuest = false;
  private intentionalClose = false;
  private joinTimeout: number | null = null;
  private pingTimer: number | null = null;

  constructor(callbacks: OnlineClientCallbacks) {
    this.callbacks = callbacks;
    this.playerId = getOrCreateClientPlayerId();
  }

  public getPlayerId(): string {
    return this.playerId;
  }

  private clearTimers(): void {
    if (this.joinTimeout !== null) {
      window.clearTimeout(this.joinTimeout);
      this.joinTimeout = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private cleanupTransport(): void {
    this.clearTimers();
    this.joinedAsGuest = false;
    this.activeRoomCode = null;

    if (this.hostRoom) {
      this.hostRoom.dispose();
      this.hostRoom = null;
    }

    for (const conn of this.guestConns.values()) {
      try {
        conn.close();
      } catch {
        // Ignore close errors
      }
    }
    this.guestConns.clear();

    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch {
        // Ignore close errors
      }
      this.hostConn = null;
    }

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.peer = null;
    }
  }

  private handleServerMessage(msg: ServerWsMessage): void {
    switch (msg.type) {
      case 'room:joined':
        this.clearJoinTimeout();
        this.joinedAsGuest = true;
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
    this.tryCreateHostPeer(0);
  }

  private tryCreateHostPeer(attempt: number): void {
    if (this.intentionalClose) return;

    const code = randomRoomCode();
    const peer = new Peer(`${ROOM_PEER_PREFIX}${code}`, PEER_OPTIONS);
    this.peer = peer;

    let opened = false;

    peer.on('open', () => {
      if (this.peer !== peer || this.intentionalClose) return;
      opened = true;
      this.activeRoomCode = code;

      const room = new P2PRoomHost(code, this.playerId, this.activePlayerName, {
        onSendToPlayer: (targetId, msg) => {
          const conn = this.guestConns.get(targetId);
          if (conn && conn.open) {
            conn.send(msg);
          }
        },
        onLocalEvent: (msg) => {
          this.handleServerMessage(msg);
        },
      });

      this.hostRoom = room;
      this.callbacks.onStatusChange('connected');
      this.callbacks.onJoined(this.playerId, room.getRoomState(), room.getBlocksSnapshot());
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

      if (!opened && errType === 'unavailable-id' && attempt < 6) {
        try {
          peer.destroy();
        } catch {
          // Ignore
        }
        this.tryCreateHostPeer(attempt + 1);
        return;
      }

      if (!opened) {
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        this.callbacks.onError(
          'P2Pルームの作成に失敗しました。通信環境をご確認のうえ再度お試しください。'
        );
      }
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
    this.callbacks.onStatusChange('connecting');

    this.joinTimeout = window.setTimeout(() => {
      if (!this.joinedAsGuest && !this.intentionalClose) {
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        this.callbacks.onError(
          'P2P接続がタイムアウトしました。コードや通信環境（モバイル回線等）を確認してください。'
        );
      }
    }, 12000);

    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer || this.intentionalClose) return;

      const conn = peer.connect(`${ROOM_PEER_PREFIX}${cleanCode}`, {
        reliable: true,
      });
      this.hostConn = conn;

      conn.on('open', () => {
        if (this.hostConn !== conn || this.intentionalClose) return;
        conn.send({
          type: 'room:join',
          roomCode: cleanCode,
          playerId: this.playerId,
          playerName: this.activePlayerName,
        } satisfies ClientWsMessage);

        this.pingTimer = window.setInterval(() => {
          if (conn.open) {
            conn.send({ type: 'ping' } satisfies ClientWsMessage);
          }
        }, 12000);
      });

      conn.on('data', (raw) => {
        const msg = raw as ServerWsMessage;
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        this.handleServerMessage(msg);
      });

      conn.on('close', () => {
        if (this.hostConn !== conn) return;
        this.clearTimers();
        const wasJoined = this.joinedAsGuest;
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        if (!this.intentionalClose && wasJoined) {
          this.callbacks.onHostClosed?.('ホストとのP2P接続が終了しました。');
        }
      });

      conn.on('error', () => {
        if (this.hostConn !== conn || this.intentionalClose) return;
        this.cleanupTransport();
        this.callbacks.onStatusChange('disconnected');
        this.callbacks.onError('ホストとのP2P接続に失敗しました。');
      });
    });

    peer.on('error', (err) => {
      if (this.peer !== peer || this.intentionalClose) return;
      const errType = (err as { type?: string })?.type;
      this.cleanupTransport();
      this.callbacks.onStatusChange('disconnected');

      if (errType === 'peer-unavailable') {
        this.callbacks.onError('ルームが見つかりません。4桁のコードを確認してください。');
      } else {
        this.callbacks.onError('P2P通信の開始に失敗しました。もう一度お試しください。');
      }
    });
  }

  public send(msg: ClientWsMessage): void {
    if (this.hostRoom) {
      this.hostRoom.handleMessage(this.playerId, msg);
      return;
    }
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(msg);
    }
  }

  public leaveRoom(): void {
    this.intentionalClose = true;

    if (this.hostRoom) {
      for (const conn of this.guestConns.values()) {
        if (conn.open) {
          try {
            conn.send({
              type: 'room:error',
              message: 'ホストがルームを退出しました。',
            } satisfies ServerWsMessage);
          } catch {
            // Ignore
          }
        }
      }
    } else if (this.hostConn && this.hostConn.open) {
      try {
        this.hostConn.send({
          type: 'room:leave',
          roomCode: this.activeRoomCode ?? '',
        } satisfies ClientWsMessage);
      } catch {
        // Ignore
      }
    }

    this.cleanupTransport();
    this.callbacks.onStatusChange('disconnected');
  }

  public dispose(): void {
    this.leaveRoom();
  }
}
