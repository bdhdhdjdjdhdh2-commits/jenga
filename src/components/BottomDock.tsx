import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Eye,
  EyeOff,
  Hand,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { CameraFocusZone, GamePhase, Handedness } from '../types/game';

interface BottomDockProps {
  phase: GamePhase;
  handedness: Handedness;
  guideEnabled: boolean;
  selectedSlot: 0 | 1 | 2;
  availableSlots: (0 | 1 | 2)[];
  selectedBlockId: number | null;
  canControl?: boolean;
  onChangeHandedness: (h: Handedness) => void;
  onToggleGuide: () => void;
  onFocusZone: (zone: CameraFocusZone) => void;
  onResetCamera: () => void;
  onSelectSlot: (slot: 0 | 1 | 2) => void;
  onConfirmPlace: () => void;
  onSlide: (dir: -1 | 0 | 1) => void;
  onClearSelection: () => void;
}

export function BottomDock({
  phase,
  handedness,
  guideEnabled,
  selectedSlot,
  availableSlots,
  selectedBlockId,
  canControl = true,
  onChangeHandedness,
  onToggleGuide,
  onFocusZone,
  onResetCamera,
  onSelectSlot,
  onConfirmPlace,
  onSlide,
  onClearSelection,
}: BottomDockProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (phase === 'menu' || phase === 'gameover' || phase === 'collapsing') {
    return null;
  }

  const alignClass =
    handedness === 'left'
      ? 'justify-start'
      : handedness === 'right'
        ? 'justify-end'
        : 'justify-center';

  const cycleHandedness = () => {
    const next: Handedness =
      handedness === 'right' ? 'center' : handedness === 'center' ? 'left' : 'right';
    onChangeHandedness(next);
  };

  const handedLabel =
    handedness === 'left' ? '左手配置' : handedness === 'right' ? '右手配置' : '中央配置';

  // Placing phase: slot picker + primary CTA (only shown to active controlling player)
  if (phase === 'placing' && canControl) {
    return (
      <div className={`pointer-events-none fixed bottom-0 left-0 right-0 z-20 pb-safe px-3 sm:px-5 flex ${alignClass}`}>
        <div className="pointer-events-auto flex w-full max-w-[360px] flex-col gap-2 rounded-2xl border border-[#241E19]/14 bg-[#FAF7F2]/96 p-2.5 shadow-lg shadow-[#241E19]/12">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-semibold text-[#4A3F35]">
              配置スロットを選択
            </span>
            <button
              type="button"
              onClick={cycleHandedness}
              className="flex min-h-[32px] items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[#6F6256] hover:bg-[#241E19]/6 whitespace-nowrap shrink-0"
            >
              <Hand className="h-3.5 w-3.5" />
              <span>{handedLabel}</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-[#EFE8DC] p-1">
            {([0, 1, 2] as const).map((slot) => {
              const label = slot === 0 ? '左' : slot === 1 ? '中央' : '右';
              const active = selectedSlot === slot;
              const isAvail = availableSlots.includes(slot);
              return (
                <button
                  key={slot}
                  type="button"
                  disabled={!isAvail}
                  onClick={() => onSelectSlot(slot)}
                  className={`min-h-[44px] rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    !isAvail
                      ? 'text-[#A89A8C] opacity-45 cursor-not-allowed'
                      : active
                        ? 'bg-[#FAF7F2] text-[#241E19] shadow-sm'
                        : 'text-[#6F6256] hover:text-[#241E19]'
                  }`}
                >
                  {isAvail ? label : `${label}(済)`}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onConfirmPlace}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl bg-[#C2592B] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-transform active:scale-[0.98] hover:bg-[#AD4C21] whitespace-nowrap shrink-0"
          >
            <Check className="h-4 w-4" />
            <span>ここに配置する</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`pointer-events-none fixed bottom-0 left-0 right-0 z-20 pb-safe px-3 sm:px-5 flex ${alignClass}`}>
      <div className="pointer-events-auto flex flex-col items-center gap-1.5 max-w-full">
        {/* Selected Block One-Handed Pull / Push Controls */}
        {canControl && selectedBlockId !== null && !collapsed && (
          <div className="flex w-full items-center gap-1.5 rounded-2xl border border-[#C2592B]/25 bg-[#FAF7F2]/96 p-1.5 shadow-md shadow-[#241E19]/10">
            <button
              type="button"
              onPointerDown={() => onSlide(-1)}
              onPointerUp={() => onSlide(0)}
              onPointerLeave={() => onSlide(0)}
              onPointerCancel={() => onSlide(0)}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#EFE8DC] px-3 text-xs font-bold text-[#241E19] transition-colors active:bg-[#DFD3BF] whitespace-nowrap shrink-0"
            >
              <ArrowUpFromLine className="h-4 w-4" />
              <span>奥へ押す</span>
            </button>
            <button
              type="button"
              onPointerDown={() => onSlide(1)}
              onPointerUp={() => onSlide(0)}
              onPointerLeave={() => onSlide(0)}
              onPointerCancel={() => onSlide(0)}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#C2592B] px-3 text-xs font-bold text-white shadow-sm transition-colors active:bg-[#9E3F16] whitespace-nowrap shrink-0"
            >
              <ArrowDownToLine className="h-4 w-4" />
              <span>手前へ引く</span>
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              aria-label="ブロックの選択を解除"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-[#EFE8DC] text-[#5A4E43] hover:text-[#241E19] shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Collapse / Expand toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? '操作パネルを表示' : '操作パネルを隠す'}
          className="flex min-h-[32px] items-center gap-1 rounded-t-xl border border-b-0 border-[#241E19]/12 bg-[#FAF7F2]/95 px-3 py-1 text-[11px] font-medium text-[#5A4E43] shadow-sm hover:text-[#241E19] whitespace-nowrap shrink-0"
        >
          {collapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              <span>操作を表示</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              <span>HUDを隠す</span>
            </>
          )}
        </button>

        {!collapsed && (
          <div className="flex items-center gap-1.5 rounded-2xl border border-[#241E19]/12 bg-[#FAF7F2]/96 p-1.5 shadow-lg shadow-[#241E19]/10">
            <div className="flex items-center gap-0.5 rounded-xl bg-[#EFE8DC] p-0.5">
              {(
                [
                  { zone: 'low', label: '下段' },
                  { zone: 'mid', label: '中段' },
                  { zone: 'top', label: '上段' },
                ] as const
              ).map(({ zone, label }) => (
                <button
                  key={zone}
                  type="button"
                  onClick={() => onFocusZone(zone)}
                  className="min-h-[44px] min-w-[44px] rounded-lg px-2.5 text-xs font-semibold text-[#4A3F35] transition-colors hover:bg-[#FAF7F2] hover:text-[#241E19] active:scale-95 whitespace-nowrap shrink-0"
                >
                  {label}
                </button>
              ))}
            </div>

            {canControl && (
              <button
                type="button"
                onClick={onToggleGuide}
                aria-label="安定度ガイドの切り替え"
                className={`flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  guideEnabled
                    ? 'bg-[#241E19] text-[#FAF7F2]'
                    : 'bg-[#EFE8DC] text-[#5A4E43] hover:text-[#241E19]'
                }`}
              >
                {guideEnabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                <span>ガイド</span>
              </button>
            )}

            <button
              type="button"
              onClick={onResetCamera}
              aria-label="視点をリセット"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-[#EFE8DC] text-[#4A3F35] transition-colors hover:bg-[#E5DCCD] active:scale-95 shrink-0"
            >
              <Compass className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={cycleHandedness}
              aria-label="片手操作の配置を切り替え"
              className="flex min-h-[44px] items-center gap-1 rounded-xl bg-[#EFE8DC] px-2.5 text-xs font-semibold text-[#4A3F35] transition-colors hover:bg-[#E5DCCD] active:scale-95 whitespace-nowrap shrink-0"
            >
              <Hand className="h-4 w-4" />
              <span className="hidden sm:inline">{handedLabel}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
