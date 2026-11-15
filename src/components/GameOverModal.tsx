import { LogOut, RotateCcw, SlidersHorizontal, Trophy } from 'lucide-react';
import type { GameMode, GameRecords } from '../types/game';

interface GameOverModalProps {
  visible: boolean;
  mode: GameMode;
  finalLayers: number;
  extractedCount: number;
  loserName: string | null;
  winnerName: string | null;
  isNewBestLayers: boolean;
  isNewBestExtracted: boolean;
  records: GameRecords;
  isOnlineHost?: boolean;
  onPlayAgain: () => void;
  onOpenMenu: () => void;
  onLeaveOnline?: () => void;
}

export function GameOverModal({
  visible,
  mode,
  finalLayers,
  extractedCount,
  loserName,
  winnerName,
  isNewBestLayers,
  isNewBestExtracted,
  records,
  isOnlineHost = false,
  onPlayAgain,
  onOpenMenu,
  onLeaveOnline,
}: GameOverModalProps) {
  if (!visible) return null;

  const isMulti = mode === 'pass_and_play' || mode === 'online';

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center p-3 sm:p-6 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-3xl border border-[#241E19]/14 bg-[#FAF7F2]/96 p-5 sm:p-6 shadow-2xl shadow-[#241E19]/20">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-[#C2592B]">
              {mode === 'online' ? 'オンライン対戦結果' : 'タワー崩壊'}
            </p>
            <h2 className="font-display mt-0.5 text-xl sm:text-2xl font-extrabold text-[#241E19]">
              {isMulti && winnerName ? `${winnerName} の勝利` : 'ゲーム終了'}
            </h2>
            {isMulti && loserName && (
              <p className="mt-0.5 text-xs text-[#5A4E43]">
                {loserName} のターンでタワーが崩れました
              </p>
            )}
          </div>

          {(isNewBestLayers || isNewBestExtracted) && (
            <div className="flex items-center gap-1 text-xs font-bold text-[#C2592B]">
              <Trophy className="h-4 w-4" />
              <span>新記録</span>
            </div>
          )}
        </div>

        {/* Clean Metrics Strip */}
        <div className="mt-4 grid grid-cols-3 gap-2 border-y border-[#241E19]/10 py-3.5 text-center">
          <div>
            <div className="text-[11px] text-[#6F6256]">到達段数</div>
            <div className="font-mono-num mt-0.5 text-xl font-bold text-[#241E19]">
              {finalLayers}段
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#6F6256]">抜取成功</div>
            <div className="font-mono-num mt-0.5 text-xl font-bold text-[#241E19]">
              {extractedCount}本
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#6F6256]">自己最高</div>
            <div className="font-mono-num mt-0.5 text-xl font-bold text-[#C2592B]">
              {records.bestLayers}段
            </div>
          </div>
        </div>

        {/* Recent History */}
        {records.history.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-[#6F6256] mb-1.5">
              最近の記録
            </div>
            <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
              {records.history.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between text-xs text-[#4A3F35]"
                >
                  <span>
                    {item.mode === 'solo'
                      ? 'ソロ練習'
                      : item.winnerName
                        ? `${item.mode === 'online' ? '[オンライン] ' : ''}勝者: ${item.winnerName}`
                        : item.mode === 'online'
                          ? 'オンライン対戦'
                          : '交互プレイ'}
                  </span>
                  <span className="font-mono-num text-[#6F6256]">
                    {item.layers}段 · {item.extracted}本
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex items-center gap-2.5">
          {mode === 'online' ? (
            <>
              <button
                type="button"
                onClick={onLeaveOnline ?? onOpenMenu}
                className="flex min-h-[46px] items-center justify-center gap-1.5 rounded-xl border border-[#241E19]/15 bg-[#EFE8DC] px-4 text-xs sm:text-sm font-semibold text-[#241E19] transition-colors hover:bg-[#E5DCCD] active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                <LogOut className="h-4 w-4" />
                <span>部屋を出る</span>
              </button>
              {isOnlineHost ? (
                <button
                  type="button"
                  onClick={onPlayAgain}
                  className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#C2592B] px-4 text-sm font-bold text-white shadow-sm transition-transform hover:bg-[#AD4C21] active:scale-[0.98] whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>もう一度遊ぶ</span>
                </button>
              ) : (
                <div className="flex min-h-[46px] flex-1 items-center justify-center rounded-xl border border-[#241E19]/12 bg-[#FAF7F2] px-3 text-xs font-semibold text-[#5A4E43] text-center">
                  ホストの再開を待っています…
                </div>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onOpenMenu}
                className="flex min-h-[46px] items-center justify-center gap-1.5 rounded-xl border border-[#241E19]/15 bg-[#EFE8DC] px-4 text-xs sm:text-sm font-semibold text-[#241E19] transition-colors hover:bg-[#E5DCCD] active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>設定へ</span>
              </button>
              <button
                type="button"
                onClick={onPlayAgain}
                className="flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#C2592B] px-4 text-sm font-bold text-white shadow-sm transition-transform hover:bg-[#AD4C21] active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-4 w-4" />
                <span>もう一度遊ぶ</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
