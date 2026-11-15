import type { GamePhase, StabilityInfo } from '../src/types/game.ts';

export const BLOCK_W = 0.8;
export const BLOCK_H = 0.48;
export const BLOCK_L = 2.4;
export const INITIAL_LAYERS = 18;
export const COASTER_TOP_Y = 0.02;
export const LAYER_GAP = 0.018;

export interface RoomPlayer {
  id: string;
  name: string;
  accentHex: string;
  connected: boolean;
  moves: number;
  isHost: boolean;
}

export interface BlockTransformState {
  id: number;
  layer: number;
  slot: 0 | 1 | 2;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  visible: boolean;
}

export interface OnlineRoomState {
  roomCode: string;
  status: 'lobby' | 'playing' | 'gameover';
  phase: GamePhase;
  players: RoomPlayer[];
  activePlayerIndex: number;
  currentLayers: number;
  extractedCount: number;
  selectedBlockId: number | null;
  activeBlockId: number | null;
  selectedSlot: 0 | 1 | 2;
  availableSlots: (0 | 1 | 2)[];
  targetPlaceLayer: number;
  stability: StabilityInfo | null;
  lockedNotice: string | null;
  winnerName: string | null;
  loserName: string | null;
}

export type SfxEventType = 'impact' | 'slide' | 'extract' | 'place' | 'collapse' | 'locked';

export type ClientWsMessage =
  | { type: 'room:create'; playerId: string; playerName: string }
  | { type: 'room:join'; roomCode: string; playerId: string; playerName: string }
  | { type: 'room:start'; roomCode: string }
  | { type: 'room:restart'; roomCode: string }
  | { type: 'room:leave'; roomCode: string }
  | { type: 'game:select_block'; blockId: number | null }
  | { type: 'game:drag_start'; blockId: number; targetX: number; targetZ: number }
  | { type: 'game:drag_move'; targetX: number; targetZ: number }
  | { type: 'game:drag_end' }
  | { type: 'game:manual_slide'; dir: -1 | 0 | 1; camX: number; camZ: number }
  | { type: 'game:select_slot'; slot: 0 | 1 | 2 }
  | { type: 'game:confirm_place' }
  | { type: 'ping' };

export type ServerWsMessage =
  | {
      type: 'room:joined';
      playerId: string;
      room: OnlineRoomState;
      blocks: BlockTransformState[];
    }
  | { type: 'room:state'; room: OnlineRoomState }
  | { type: 'room:error'; message: string }
  | { type: 'physics:full'; blocks: BlockTransformState[] }
  | { type: 'physics:delta'; blocks: BlockTransformState[] }
  | { type: 'sfx:event'; sfx: SfxEventType; intensity?: number }
  | { type: 'pong' };
