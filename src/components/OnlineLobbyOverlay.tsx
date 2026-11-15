import { Check, Copy, LogOut, Play, Share2, Users } from 'lucide-react';
import { useState } from 'react';
import type { OnlineRoomState } from '../../shared/jengaProtocol';

interface OnlineLobbyOverlayProps {
  room: OnlineRoomState | null;
  myPlayerId: string;
  errorMsg: string | null;
  onStartMatch: () => void;
  onLeaveRoom: () => void;
}

export function OnlineLobbyOverlay({
  room,
  myPlayerId,
  errorMsg,
  onStartMatch,
  onLeaveRoom,
}: OnlineLobbyOverlayProps) {
  const [copiedType, setCopiedType] = useState<'code' | 'link' | null>(null);

  if (!room || room.status !== 'lobby') return null;

  const me = room.players.find((p) => p.id === myPlayerId);
  const isHost = Boolean(me?.isHost);
  const connectedCount = room.players.filter((p) => p.connected).length;
  const canStart = isHost && connectedCount >= 2;

  const inviteUrl = (() => {
    try {
      const url = new URL(window.location.href);
      url.search = `?room=${room.roomCode}`;
      url.hash = '';
      return url.toString();
    } catch {
      return `${window.location.origin}/?room=${room.roomCode}`;
    }
  })();

  const copyText = async (text: string, type: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      window.setTimeout(() => {
        setCopiedType((prev) => (prev === type ? null : prev));
      }, 2000);
    } catch {
      // Fallback: ignore if clipboard API unavailable
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'KIGUMI オンライン対戦',
          text: `KIGUMIでジェンガ対戦しませんか？ ルームコード: ${room.roomCode}`,
          url: inviteUrl,
        });
        return;
      } catch {
        // Fallback to copy
      }
    }
    void copyText(inviteUrl, 'link');
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center p-3 sm:p-6 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-3xl border border-[#241E19]/14 bg-[#FAF7F2]/96 p-5 sm:p-6 shadow-2xl shadow-[#241E19]/18">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-[#C2592B]">オンライン対戦ロビー</p>
            <h2 className="font-display mt-0.5 text-xl sm:text-2xl font-extrabold text-[#241E19]">
              仲間を待っています
            </h2>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#5A4E43] pt-1 whitespace-nowrap shrink-0">
            <Users className="h-4 w-4 text-[#C2592B]" />
            <span className="font-mono-num">{room.players.length} / 4人</span>
          </div>
        </div>

        {/* 4-Digit Room Code & Invite Link */}
        <div className="mt-4 rounded-2xl border border-[#241E19]/12 bg-[#EFE8DC] p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold text-[#6F6256]">ルームコード</div>
              <div className="font-mono-num mt-0.5 text-3xl font-extrabold tracking-[0.18em] text-[#241E19]">
                {room.roomCode}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void copyText(room.roomCode, 'code')}
                className="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-[#241E19]/12 bg-[#FAF7F2] px-3 text-xs font-semibold text-[#241E19] shadow-xs transition-colors hover:bg-white active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                {copiedType === 'code' ? (
                  <>
                    <Check className="h-4 w-4 text-[#1B7A43]" />
                    <span>コピー済</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 text-[#5A4E43]" />
                    <span>コード</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => void handleShare()}
                className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#241E19] px-3 text-xs font-semibold text-[#FAF7F2] shadow-xs transition-colors hover:bg-[#3A3129] active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                {copiedType === 'link' ? (
                  <>
                    <Check className="h-4 w-4 text-[#7AD69E]" />
                    <span>URLコピー済</span>
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4" />
                    <span>招待URL</span>
                  </>
                )}
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-[#6F6256] truncate">
            {inviteUrl}
          </p>
        </div>

        {/* Player List */}
        <div className="mt-4 space-y-1.5">
          <div className="text-xs font-semibold text-[#4A3F35]">参加メンバー</div>
          <div className="divide-y divide-[#241E19]/10 rounded-2xl border border-[#241E19]/10 bg-white/80">
            {room.players.map((p) => {
              const isMe = p.id === myPlayerId;
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs sm:text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: p.accentHex }}
                    />
                    <span className="font-semibold text-[#241E19] truncate">
                      {p.name}
                    </span>
                    {isMe && (
                      <span className="text-[11px] font-semibold text-[#C2592B] whitespace-nowrap shrink-0">
                        (あなた)
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] font-medium shrink-0">
                    {p.isHost && (
                      <span className="font-semibold text-[#6F6256] whitespace-nowrap">
                        ホスト
                      </span>
                    )}
                    <span className={p.connected ? 'text-[#1B7A43]' : 'text-[#9C8D7E]'}>
                      {p.connected ? '接続中' : '再接続待ち'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {errorMsg && (
          <p className="mt-3 rounded-xl border border-[#C82828]/25 bg-[#FEF2F2] px-3 py-2 text-xs font-medium text-[#991B1B]">
            {errorMsg}
          </p>
        )}

        {/* Actions */}
        <div className="mt-4 flex items-center gap-2.5">
          <button
            type="button"
            onClick={onLeaveRoom}
            className="flex min-h-[46px] items-center justify-center gap-1.5 rounded-xl border border-[#241E19]/15 bg-[#EFE8DC] px-4 text-xs sm:text-sm font-semibold text-[#241E19] transition-colors hover:bg-[#E5DCCD] active:scale-[0.98] whitespace-nowrap shrink-0"
          >
            <LogOut className="h-4 w-4" />
            <span>部屋を出る</span>
          </button>

          {isHost ? (
            <button
              type="button"
              disabled={!canStart}
              onClick={onStartMatch}
              className={`flex min-h-[46px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold text-white shadow-sm transition-all whitespace-nowrap shrink-0 ${
                canStart
                  ? 'bg-[#C2592B] hover:bg-[#AD4C21] active:scale-[0.98]'
                  : 'bg-[#C2592B]/45 cursor-not-allowed'
              }`}
            >
              <Play className="h-4 w-4 fill-current" />
              <span>{connectedCount < 2 ? '2人以上で開始できます' : '対戦スタート'}</span>
            </button>
          ) : (
            <div className="flex min-h-[46px] flex-1 items-center justify-center rounded-xl border border-[#241E19]/12 bg-[#FAF7F2] px-3 text-xs font-semibold text-[#5A4E43] text-center">
              ホストの開始を待っています…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
