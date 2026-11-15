import type { GameRecords, RunHistoryEntry, UserSettings } from '../types/game';

const SETTINGS_KEY = 'kigumi_jenga_settings_v1';
const RECORDS_KEY = 'kigumi_jenga_records_v1';

const DEFAULT_SETTINGS: UserSettings = {
  soundEnabled: true,
  guideEnabled: true,
  handedness: 'right',
  hapticsEnabled: true,
};

const DEFAULT_RECORDS: GameRecords = {
  bestLayers: 18,
  bestExtracted: 0,
  totalGames: 0,
  history: [],
};

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      soundEnabled: parsed.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled,
      guideEnabled: parsed.guideEnabled ?? DEFAULT_SETTINGS.guideEnabled,
      handedness:
        parsed.handedness === 'left' ||
        parsed.handedness === 'center' ||
        parsed.handedness === 'right'
          ? parsed.handedness
          : DEFAULT_SETTINGS.handedness,
      hapticsEnabled: parsed.hapticsEnabled ?? DEFAULT_SETTINGS.hapticsEnabled,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadRecords(): GameRecords {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return DEFAULT_RECORDS;
    const parsed = JSON.parse(raw) as Partial<GameRecords>;
    return {
      bestLayers: typeof parsed.bestLayers === 'number' ? parsed.bestLayers : 18,
      bestExtracted: typeof parsed.bestExtracted === 'number' ? parsed.bestExtracted : 0,
      totalGames: typeof parsed.totalGames === 'number' ? parsed.totalGames : 0,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 6) : [],
    };
  } catch {
    return DEFAULT_RECORDS;
  }
}

export function recordCompletedRun(entry: Omit<RunHistoryEntry, 'id' | 'timestamp'>): {
  records: GameRecords;
  isNewBestLayers: boolean;
  isNewBestExtracted: boolean;
} {
  const prev = loadRecords();
  const isNewBestLayers = entry.layers > prev.bestLayers;
  const isNewBestExtracted = entry.extracted > prev.bestExtracted;

  const newEntry: RunHistoryEntry = {
    ...entry,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
  };

  const next: GameRecords = {
    bestLayers: Math.max(prev.bestLayers, entry.layers),
    bestExtracted: Math.max(prev.bestExtracted, entry.extracted),
    totalGames: prev.totalGames + 1,
    history: [newEntry, ...prev.history].slice(0, 6),
  };

  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }

  return { records: next, isNewBestLayers, isNewBestExtracted };
}
