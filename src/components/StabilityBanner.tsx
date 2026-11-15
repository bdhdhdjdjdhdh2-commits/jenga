import { AlertTriangle, CheckCircle2, Eye, Lock, ShieldAlert } from 'lucide-react';
import type { GamePhase, StabilityInfo } from '../types/game';

interface StabilityBannerProps {
  phase: GamePhase;
  guideEnabled: boolean;
  stability: StabilityInfo | null;
  lockedNotice: string | null;
  turnNotice: string | null;
  isSpectatingOnline?: boolean;
  activePlayerName?: string | null;
}

export function StabilityBanner({
  phase,
  guideEnabled,
  stability,
  lockedNotice,
  turnNotice,
  isSpectatingOnline = false,
  activePlayerName = null,
}: StabilityBannerProps) {
  if (phase === 'menu' || phase === 'gameover') return null;

  // Priority 1: Slow-motion collapse banner
  if (phase === 'collapsing') {
    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[#C2592B]/30 bg-[#FAF7F2]/95 px-3.5 py-2 text-xs font-semibold text-[#9E3D16] shadow-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>タワー崩落中（スローモーション）</span>
        </div>
      </div>
    );
  }

  // Priority 2: Online spectator banner (active turn belongs to another player)
  if (isSpectatingOnline) {
    const text =
      phase === 'placing'
        ? `${activePlayerName ?? '相手'} さんが配置位置を選んでいます…`
        : phase === 'settling'
          ? 'タワーの安定を確認しています…'
          : `${activePlayerName ?? '相手'} さんが操作中 · カメラを回して観戦できます`;

    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[#241E19]/14 bg-[#FAF7F2]/95 px-3.5 py-1.5 text-xs font-medium text-[#241E19] shadow-sm">
          <Eye className="h-3.5 w-3.5 shrink-0 text-[#2C6E7F]" />
          <span className="truncate max-w-[290px] sm:max-w-none">{text}</span>
        </div>
      </div>
    );
  }

  // Priority 3: Locked layer feedback
  if (lockedNotice) {
    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[#241E19]/15 bg-[#FAF7F2]/95 px-3.5 py-2 text-xs font-medium text-[#4A3F35] shadow-sm">
          <Lock className="h-3.5 w-3.5 shrink-0 text-[#7A6C5F]" />
          <span>{lockedNotice}</span>
        </div>
      </div>
    );
  }

  // Priority 4: Placing or settling guidance
  if (phase === 'placing') {
    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[#C2592B]/30 bg-[#FAF7F2]/95 px-3.5 py-1.5 text-xs font-medium text-[#241E19] shadow-sm">
          <span>最上段の置く位置を選び「ここに配置」を押してください</span>
        </div>
      </div>
    );
  }

  if (phase === 'settling') {
    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="flex items-center gap-2 rounded-xl border border-[#241E19]/12 bg-[#FAF7F2]/95 px-3.5 py-1.5 text-xs font-medium text-[#5A4E43] shadow-sm">
          <span>タワーの安定を確認しています…</span>
        </div>
      </div>
    );
  }

  // Priority 5: Stability guide while inspecting/pulling a block
  if (guideEnabled && stability && stability.level !== 'locked') {
    const styleMap = {
      safe: {
        border: 'border-[#1B7A43]/30',
        text: 'text-[#155E34]',
        icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-[#1B7A43]" />,
      },
      caution: {
        border: 'border-[#D97706]/35',
        text: 'text-[#9A4E04]',
        icon: <AlertTriangle className="h-4 w-4 shrink-0 text-[#D97706]" />,
      },
      risky: {
        border: 'border-[#C82828]/35',
        text: 'text-[#991B1B]',
        icon: <ShieldAlert className="h-4 w-4 shrink-0 text-[#C82828]" />,
      },
    }[stability.level];

    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div
          className={`flex items-center gap-2 rounded-xl border ${styleMap.border} bg-[#FAF7F2]/95 px-3.5 py-1.5 text-xs shadow-sm`}
        >
          {styleMap.icon}
          <span className={`font-bold whitespace-nowrap ${styleMap.text}`}>
            {stability.label}
          </span>
          <span aria-hidden="true" className="text-[#241E19]/25">
            ·
          </span>
          <span className="text-[#4A3F35] truncate max-w-[230px] sm:max-w-none">
            {stability.hint}
          </span>
        </div>
      </div>
    );
  }

  // Priority 6: Brief turn transition banner
  if (turnNotice) {
    return (
      <div className="pointer-events-none fixed top-[68px] left-0 right-0 z-20 flex justify-center px-4">
        <div className="rounded-xl border border-[#241E19]/12 bg-[#FAF7F2]/95 px-3.5 py-1.5 text-xs font-medium text-[#241E19] shadow-sm">
          {turnNotice}
        </div>
      </div>
    );
  }

  return null;
}
