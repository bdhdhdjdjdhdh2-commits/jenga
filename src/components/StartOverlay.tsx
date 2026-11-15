import { Globe, Play, Trophy, User, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GameMode, GameRecords, Handedness } from '../types/game';

interface StartOverlayProps {
  visible: boolean;
  records: GameRecords;
  initialMode: GameMode;
  initialRoomCode?: string;
  handedness: Handedness;
  onlineConnecting?: boolean;
  onlineError?: string | null;
  onChangeHandedness: (h: Handedness) => void;
  onStartGame: (mode: GameMode, playerNames: string[]) => void;
  onCreateOnlineRoom: (playerName: string) => void;
  onJoinOnlineRoom: (roomCode: string, playerName: string) => void;
}

const DEFAULT_NAMES = ['プレイヤー1', 'プレイヤー2', 'プレイヤー3', 'プレイヤー4'];

export function StartOverlay({
  visible,
  records,
  initialMode,
  initialRoomCode = '',
  handedness,
  onlineConnecting = false,
  onlineError = null,
  onChangeHandedness,
  onStartGame,
  onCreateOnlineRoom,
  onJoinOnlineRoom,
}: StartOverlayProps) {
  const [mode, setMode] = useState<GameMode>(initialRoomCode ? 'online' : initialMode);
  const [playerCount, setPlayerCount] = useState<number>(2);
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES);

  const [onlineAction, setOnlineAction] = useState<'create' | 'join'>(
    initialRoomCode ? 'join' : 'create'
  );
  const [onlineName, setOnlineName] = useState<string>('プレイヤー');
  const [roomCodeInput, setRoomCodeInput] = useState<string>(initialRoomCode);

  useEffect(() => {
    if (initialRoomCode) {
      setMode('online');
      setOnlineAction('join');
      setRoomCodeInput(initialRoomCode);
    }
  }, [initialRoomCode]);

  if (!visible) return null;

  const handleNameChange = (idx: number, val: string) => {
    setNames((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const cleanRoomCode = roomCodeInput.replace(/\D/g, '').slice(0, 4);
  const isOnlineJoinInvalid =
    mode === 'online' && onlineAction === 'join' && cleanRoomCode.length !== 4;

  const handleSubmit = () => {
    if (mode === 'online') {
      if (onlineConnecting) return;
      const nick = onlineName.trim() || 'プレイヤー';
      if (onlineAction === 'create') {
        onCreateOnlineRoom(nick);
      } else if (cleanRoomCode.length === 4) {
        onJoinOnlineRoom(cleanRoomCode, nick);
      }
      return;
    }

    const activeNames = names
      .slice(0, playerCount)
      .map((n, i) => n.trim() || `プレイヤー${i + 1}`);
    onStartGame(mode, activeNames);
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center p-3 sm:p-6 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-3xl border border-[#241E19]/14 bg-[#FAF7F2]/96 p-5 sm:p-6 shadow-2xl shadow-[#241E19]/18">
        {/* Title & concise summary */}
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[#241E19]">
            KIGUMI
          </h1>
          <div className="flex items-center gap-1.5 text-xs text-[#6F6256]">
            <Trophy className="h-3.5 w-3.5 text-[#C2592B]" />
            <span className="font-mono-num font-semibold text-[#241E19]">
              最高 {records.bestLayers}段
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">抜取 {records.bestExtracted}本</span>
          </div>
        </div>
        <p className="mt-1 text-xs sm:text-sm text-[#5A4E43] leading-relaxed">
          スワイプで視点を回し、木製ブロックを指で引き抜いて最上段へ積み上げよう。
        </p>

        {/* Mode Segmented Selector (Solo / Pass & Play / Online) */}
        <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-[#EFE8DC] p-1">
          <button
            type="button"
            onClick={() => setMode('solo')}
            className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              mode === 'solo'
                ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                : 'text-[#6F6256] hover:text-[#241E19]'
            }`}
          >
            <User className="h-3.5 w-3.5 shrink-0" />
            <span>ソロ練習</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('pass_and_play')}
            className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              mode === 'pass_and_play'
                ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                : 'text-[#6F6256] hover:text-[#241E19]'
            }`}
          >
            <Users className="h-3.5 w-3.5 shrink-0" />
            <span>1台で交互</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('online')}
            className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              mode === 'online'
                ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                : 'text-[#6F6256] hover:text-[#241E19]'
            }`}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span>オンライン</span>
          </button>
        </div>

        {/* Pass & Play Options */}
        {mode === 'pass_and_play' && (
          <div className="mt-3.5 space-y-2.5 border-t border-[#241E19]/10 pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#4A3F35]">参加人数</span>
              <div className="flex items-center gap-1 rounded-lg bg-[#EFE8DC] p-0.5">
                {[2, 3, 4].map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    onClick={() => setPlayerCount(cnt)}
                    className={`min-h-[36px] min-w-[44px] rounded-md px-2 text-xs font-bold transition-colors ${
                      playerCount === cnt
                        ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                        : 'text-[#6F6256]'
                    }`}
                  >
                    {cnt}人
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: playerCount }).map((_, idx) => (
                <input
                  key={idx}
                  type="text"
                  maxLength={12}
                  value={names[idx]}
                  onChange={(e) => handleNameChange(idx, e.target.value)}
                  placeholder={`プレイヤー${idx + 1}`}
                  className="min-h-[42px] w-full rounded-xl border border-[#241E19]/15 bg-white px-3 text-xs font-medium text-[#241E19] outline-none focus:border-[#C2592B]"
                />
              ))}
            </div>
          </div>
        )}

        {/* Online Multiplayer Options */}
        {mode === 'online' && (
          <div className="mt-3.5 space-y-2.5 border-t border-[#241E19]/10 pt-3.5">
            <div>
              <label className="block text-[11px] font-semibold text-[#4A3F35] mb-1">
                あなたの表示名（2〜4人対戦）
              </label>
              <input
                type="text"
                maxLength={12}
                value={onlineName}
                onChange={(e) => setOnlineName(e.target.value)}
                placeholder="ニックネームを入力"
                className="min-h-[42px] w-full rounded-xl border border-[#241E19]/15 bg-white px-3 text-xs sm:text-sm font-medium text-[#241E19] outline-none focus:border-[#C2592B]"
              />
            </div>

            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#EFE8DC] p-1">
              <button
                type="button"
                onClick={() => setOnlineAction('create')}
                className={`min-h-[38px] rounded-lg px-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  onlineAction === 'create'
                    ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                    : 'text-[#6F6256]'
                }`}
              >
                部屋をつくる
              </button>
              <button
                type="button"
                onClick={() => setOnlineAction('join')}
                className={`min-h-[38px] rounded-lg px-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  onlineAction === 'join'
                    ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                    : 'text-[#6F6256]'
                }`}
              >
                コードで参加
              </button>
            </div>

            {onlineAction === 'join' ? (
              <div>
                <label className="block text-[11px] font-semibold text-[#4A3F35] mb-1">
                  4桁のルームコード
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={cleanRoomCode}
                  onChange={(e) => setRoomCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="例: 4829"
                  className="font-mono-num min-h-[44px] w-full rounded-xl border border-[#241E19]/15 bg-white px-3 text-center text-lg font-bold tracking-[0.28em] text-[#241E19] outline-none focus:border-[#C2592B]"
                />
              </div>
            ) : (
              <p className="text-[11px] text-[#6F6256] leading-relaxed">
                WebRTC（P2P）で別端末と直接通信します。4桁のコードと招待URLが発行され、作成者がホストになります。
              </p>
            )}

            {onlineError && (
              <p className="rounded-xl border border-[#C82828]/25 bg-[#FEF2F2] px-3 py-2 text-xs font-medium text-[#991B1B]">
                {onlineError}
              </p>
            )}
          </div>
        )}

        {/* Handedness preference */}
        <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-[#241E19]/10 pt-3">
          <span className="text-xs font-semibold text-[#4A3F35]">片手操作レイアウト</span>
          <div className="flex items-center gap-1 rounded-lg bg-[#EFE8DC] p-0.5">
            {(
              [
                { val: 'left', label: '左手' },
                { val: 'center', label: '中央' },
                { val: 'right', label: '右手' },
              ] as const
            ).map(({ val, label }) => (
              <button
                key={val}
                type="button"
                onClick={() => onChangeHandedness(val)}
                className={`min-h-[36px] min-w-[44px] rounded-md px-2 text-xs font-semibold transition-colors ${
                  handedness === val
                    ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                    : 'text-[#6F6256]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Start CTA */}
        <button
          type="button"
          disabled={onlineConnecting || isOnlineJoinInvalid}
          onClick={handleSubmit}
          className={`mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white shadow-md transition-all ${
            onlineConnecting || isOnlineJoinInvalid
              ? 'bg-[#C2592B]/45 cursor-not-allowed shadow-none'
              : 'bg-[#C2592B] shadow-[#C2592B]/25 hover:bg-[#AD4C21] active:scale-[0.98]'
          }`}
        >
          <Play className="h-4 w-4 fill-current" />
          <span>
            {mode === 'online'
              ? onlineConnecting
                ? '接続中…'
                : onlineAction === 'create'
                  ? '部屋をつくる'
                  : '部屋に参加する'
              : 'ゲーム開始'}
          </span>
        </button>
      </div>
    </div>
  );
}
