export type GameMode = 'solo' | 'pass_and_play' | 'online';

export type GamePhase =
  | 'menu'
  | 'inspect'
  | 'pulling'
  | 'placing'
  | 'settling'
  | 'collapsing'
  | 'gameover';

export type Handedness = 'left' | 'center' | 'right';

export type CameraFocusZone = 'low' | 'mid' | 'top';

export type StabilityLevel = 'safe' | 'caution' | 'risky' | 'locked';

export interface StabilityInfo {
  blockId: number;
  level: StabilityLevel;
  label: string;
  hint: string;
}

export interface PlayerInfo {
  id: string;
  name: string;
  moves: number;
  accentHex: string;
}

export interface RunHistoryEntry {
  id: string;
  mode: GameMode;
  layers: number;
  extracted: number;
  winnerName: string | null;
  loserName: string | null;
  timestamp: number;
}

export interface GameRecords {
  bestLayers: number;
  bestExtracted: number;
  totalGames: number;
  history: RunHistoryEntry[];
}

export interface UserSettings {
  soundEnabled: boolean;
  guideEnabled: boolean;
  handedness: Handedness;
  hapticsEnabled: boolean;
}

export interface TowerSnapshot {
  phase: GamePhase;
  currentLayers: number;
  extractedCount: number;
  selectedSlot: 0 | 1 | 2;
  availableSlots: (0 | 1 | 2)[];
  selectedBlockId: number | null;
  stability: StabilityInfo | null;
  lockedNotice: string | null;
  isPullableHover: boolean;
  topLayerCount: number;
}
