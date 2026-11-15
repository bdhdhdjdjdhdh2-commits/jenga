import { LogOut, Menu, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { GameMode, GamePhase, PlayerInfo } from '../types/game';

interface TopHudProps {
  mode: GameMode;
  phase: GamePhase;
  currentLayers: number;
  extractedCount: number;
  bestLayers: number;
  activePlayer: PlayerInfo | null;
  roomCode?: string | null;
  isMyOnlineTurn?: boolean;
  isOnlineHost?: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onRestart: () => void;
  onOpenMenu: () => void;
  onLeaveOnline?: () => void;
}

export function TopHud({
  mode,
  phase,
  currentLayers,
  extractedCount,
  bestLayers,
  activePlayer,
  roomCode = null,
  isMyOnlineTurn = false,
  isOnlineHost = false,
  soundEnabled,
  onToggleSound,
  onRestart,
  onOpenMenu,
  onLeaveOnline,
}: TopHudProps) {
  if (phase === 'menu') return null;

  const isOnline = mode === 'online';
  const showPlayerBadge = (mode === 'pass_and_play' || isOnline) && Boolean(activePlayer);

  return (
    <header className="pointer-events-none fixed top-0 left-0 right-0 z-20 pt-safe px-3 sm:px-5">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 rounded-2xl border border-[#241E19]/12 bg-[#FAF7F2]/95 px-3 py-1.5 shadow-md shadow-[#241E19]/8">
        {/* Zone 1: Brand + Unboxed Live Metadata */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-display text-sm font-extrabold tracking-tight text-[#241E19] whitespace-nowrap shrink-0">
            KIGUMI
          </span>
          <span aria-hidden="true" className="text-[#241E19]/25">
            /
          </span>
          <div className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm text-[#5A4E43] truncate">
            {showPlayerBadge && activePlayer ? (
              <>
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: activePlayer.accentHex }}
                />
                <span className="font-semibold text-[#241E19] truncate">
                  {activePlayer.name}
                </span>
                {isOnline && (
                  <span
                    className={`text-[11px] font-bold whitespace-nowrap shrink-0 ${
                      isMyOnlineTurn ? 'text-[#C2592B]' : 'text-[#6F6256]'
                    }`}
                  >
                    {isMyOnlineTurn ? '· あなた' : '· 観戦'}
                  </span>
                )}
                <span aria-hidden="true" className="text-[#241E19]/30">
                  ·
                </span>
              </>
            ) : null}
            <span className="font-mono-num font-semibold text-[#241E19] whitespace-nowrap shrink-0">
              {currentLayers}段
            </span>
            <span aria-hidden="true" className="text-[#241E19]/30">
              ·
            </span>
            <span className="font-mono-num whitespace-nowrap shrink-0">
              抜取 {extractedCount}
            </span>
            {isOnline && roomCode ? (
              <>
                <span aria-hidden="true" className="hidden sm:inline text-[#241E19]/30">
                  ·
                </span>
                <span className="hidden sm:inline font-mono-num text-[#7A6C5F] whitespace-nowrap shrink-0">
                  部屋 {roomCode}
                </span>
              </>
            ) : (
              <>
                <span aria-hidden="true" className="hidden sm:inline text-[#241E19]/30">
                  ·
                </span>
                <span className="hidden sm:inline font-mono-num text-[#7A6C5F] whitespace-nowrap shrink-0">
                  最高 {bestLayers}段
                </span>
              </>
            )}
          </div>
        </div>

        {/* Zone 2: Minimal Action Buttons (>= 44x44px hitboxes) */}
        <div className="pointer-events-auto flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onToggleSound}
            aria-label={soundEnabled ? '効果音をオフ' : '効果音をオン'}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[#4A3F35] transition-colors hover:bg-[#241E19]/6 active:scale-95"
          >
            {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-[#9C8D7E]" />}
          </button>
          {(!isOnline || isOnlineHost) && (
            <button
              type="button"
              onClick={onRestart}
              aria-label="タワーを最初からやり直す"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[#4A3F35] transition-colors hover:bg-[#241E19]/6 active:scale-95"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={isOnline && onLeaveOnline ? onLeaveOnline : onOpenMenu}
            aria-label={isOnline ? 'ルームを退出' : 'メニューを開く'}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[#4A3F35] transition-colors hover:bg-[#241E19]/6 active:scale-95"
          >
            {isOnline ? <LogOut className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
