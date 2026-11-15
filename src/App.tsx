import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnlineRoomState } from '../shared/jengaProtocol';
import { woodAudio } from './audio/woodAudio';
import { BottomDock } from './components/BottomDock';
import { GameOverModal } from './components/GameOverModal';
import { OnlineLobbyOverlay } from './components/OnlineLobbyOverlay';
import { StabilityBanner } from './components/StabilityBanner';
import { StartOverlay } from './components/StartOverlay';
import { TopHud } from './components/TopHud';
import { JengaEngine } from './engine/jengaEngine';
import { OnlineJengaClient, type ConnectionStatus } from './network/onlineClient';
import type {
  CameraFocusZone,
  GameMode,
  GameRecords,
  Handedness,
  PlayerInfo,
  TowerSnapshot,
  UserSettings,
} from './types/game';
import {
  loadRecords,
  loadSettings,
  recordCompletedRun,
  saveSettings,
} from './utils/storage';

const PLAYER_ACCENTS = ['#C2592B', '#2C6E7F', '#2E7D4F', '#A16207'];

const INITIAL_SNAPSHOT: TowerSnapshot = {
  phase: 'menu',
  currentLayers: 18,
  extractedCount: 0,
  selectedSlot: 1,
  availableSlots: [0, 1, 2],
  selectedBlockId: null,
  stability: null,
  lockedNotice: null,
  isPullableHover: false,
  topLayerCount: 3,
};

function readInviteRoomCode(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get('room') ?? '';
    const clean = raw.replace(/\D/g, '').slice(0, 4);
    return clean.length === 4 ? clean : '';
  } catch {
    return '';
  }
}

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<JengaEngine | null>(null);
  const onlineClientRef = useRef<OnlineJengaClient | null>(null);

  const [initialInviteCode] = useState<string>(() => readInviteRoomCode());
  const [webglError, setWebglError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings());
  const [records, setRecords] = useState<GameRecords>(() => loadRecords());

  const [mode, setMode] = useState<GameMode>(() => (initialInviteCode ? 'online' : 'solo'));
  const [players, setPlayers] = useState<PlayerInfo[]>([
    { id: 'p1', name: 'プレイヤー1', moves: 0, accentHex: PLAYER_ACCENTS[0] },
  ]);
  const [activePlayerIdx, setActivePlayerIdx] = useState(0);
  const [snapshot, setSnapshot] = useState<TowerSnapshot>(INITIAL_SNAPSHOT);
  const [turnNotice, setTurnNotice] = useState<string | null>(null);
  const [gameOverResult, setGameOverResult] = useState<{
    finalLayers: number;
    extractedCount: number;
    loserName: string | null;
    winnerName: string | null;
    isNewBestLayers: boolean;
    isNewBestExtracted: boolean;
  } | null>(null);

  // Online multiplayer state
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoomState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string>('');
  const [onlineStatus, setOnlineStatus] = useState<ConnectionStatus>('disconnected');
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [onlinePendingAction, setOnlinePendingAction] = useState(false);

  // Refs to keep callbacks fresh without remounting WebGL or WebSocket
  const modeRef = useRef(mode);
  const playersRef = useRef(players);
  const activePlayerIdxRef = useRef(activePlayerIdx);
  const myPlayerIdRef = useRef(myPlayerId);
  const prevOnlineStatusRef = useRef<OnlineRoomState['status'] | null>(null);
  const prevOnlineTurnIdxRef = useRef<number | null>(null);
  const turnTimerRef = useRef<number | null>(null);

  modeRef.current = mode;
  playersRef.current = players;
  activePlayerIdxRef.current = activePlayerIdx;
  myPlayerIdRef.current = myPlayerId;

  const showTurnNotice = useCallback((msg: string, durationMs = 2200) => {
    setTurnNotice(msg);
    if (turnTimerRef.current) window.clearTimeout(turnTimerRef.current);
    turnTimerRef.current = window.setTimeout(() => {
      setTurnNotice(null);
    }, durationMs);
  }, []);

  // Initialize Three.js + Cannon-es engine once
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    woodAudio.setEnabled(settings.soundEnabled);

    try {
      const engine = new JengaEngine(container, {
        onSnapshot: (nextSnap) => {
          setSnapshot(nextSnap);
        },
        onTurnComplete: (_newLayers, _extracted) => {
          const curMode = modeRef.current;
          if (curMode === 'online') return;

          const curPlayers = playersRef.current;
          const curIdx = activePlayerIdxRef.current;

          if (curMode === 'pass_and_play' && curPlayers.length > 1) {
            const nextIdx = (curIdx + 1) % curPlayers.length;
            setPlayers((prev) =>
              prev.map((p, idx) => (idx === curIdx ? { ...p, moves: p.moves + 1 } : p))
            );
            setActivePlayerIdx(nextIdx);
            showTurnNotice(`次は ${curPlayers[nextIdx].name} の番です`);
          } else {
            showTurnNotice('配置完了！次のブロックをどうぞ');
          }
        },
        onCollapse: (finalLayers, extractedCount) => {
          const curMode = modeRef.current;
          if (curMode === 'online') return;

          const curPlayers = playersRef.current;
          const curIdx = activePlayerIdxRef.current;

          let loserName: string | null = null;
          let winnerName: string | null = null;

          if (curMode === 'pass_and_play' && curPlayers.length > 1) {
            loserName = curPlayers[curIdx]?.name ?? null;
            const prevIdx = (curIdx - 1 + curPlayers.length) % curPlayers.length;
            winnerName =
              extractedCount > 0 ? (curPlayers[prevIdx]?.name ?? null) : curPlayers[prevIdx]?.name ?? null;
          }

          const outcome = recordCompletedRun({
            mode: curMode,
            layers: finalLayers,
            extracted: extractedCount,
            winnerName,
            loserName,
          });
          setRecords(outcome.records);
          setGameOverResult({
            finalLayers,
            extractedCount,
            loserName,
            winnerName,
            isNewBestLayers: outcome.isNewBestLayers,
            isNewBestExtracted: outcome.isNewBestExtracted,
          });
        },
        onOnlineInput: (msg) => {
          onlineClientRef.current?.send(msg);
        },
      });

      engine.setGuideEnabled(settings.guideEnabled);
      engine.setHapticsEnabled(settings.hapticsEnabled);
      engineRef.current = engine;

      return () => {
        if (turnTimerRef.current) window.clearTimeout(turnTimerRef.current);
        engine.dispose();
        engineRef.current = null;
      };
    } catch {
      setWebglError('3D表示（WebGL）の初期化に失敗しました。ブラウザ設定をご確認ください。');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize Online WebSocket Client once
  useEffect(() => {
    const syncRoomState = (room: OnlineRoomState, playerId: string) => {
      const prevStatus = prevOnlineStatusRef.current;
      const prevTurnIdx = prevOnlineTurnIdxRef.current;

      setOnlineRoom(room);
      setOnlineError(null);
      setOnlinePendingAction(false);

      engineRef.current?.applyRemoteRoomState(room, playerId);

      if (room.status === 'playing') {
        if (prevStatus !== 'playing') {
          setGameOverResult(null);
        }
        if (prevStatus !== 'playing' || prevTurnIdx !== room.activePlayerIndex) {
          const turnPlayer = room.players[room.activePlayerIndex];
          if (turnPlayer) {
            if (turnPlayer.id === playerId) {
              showTurnNotice('あなたのターンです！ブロックを引き抜いてください', 2600);
            } else {
              showTurnNotice(`${turnPlayer.name} さんのターンです`, 2200);
            }
          }
        }
      } else if (room.status === 'gameover' && prevStatus !== 'gameover') {
        const outcome = recordCompletedRun({
          mode: 'online',
          layers: room.currentLayers,
          extracted: room.extractedCount,
          winnerName: room.winnerName,
          loserName: room.loserName,
        });
        setRecords(outcome.records);
        setGameOverResult({
          finalLayers: room.currentLayers,
          extractedCount: room.extractedCount,
          loserName: room.loserName,
          winnerName: room.winnerName,
          isNewBestLayers: outcome.isNewBestLayers,
          isNewBestExtracted: outcome.isNewBestExtracted,
        });
      }

      prevOnlineStatusRef.current = room.status;
      prevOnlineTurnIdxRef.current = room.activePlayerIndex;
    };

    const client = new OnlineJengaClient({
      onStatusChange: (status) => {
        setOnlineStatus(status);
        if (status === 'disconnected') {
          setOnlinePendingAction(false);
        }
      },
      onJoined: (playerId, room, blocks) => {
        myPlayerIdRef.current = playerId;
        setMyPlayerId(playerId);
        setMode('online');
        prevOnlineStatusRef.current = null;
        prevOnlineTurnIdxRef.current = null;
        engineRef.current?.setOnlineMode(true);
        engineRef.current?.applyRemotePhysics(blocks, true);
        syncRoomState(room, playerId);
      },
      onRoomState: (room) => {
        syncRoomState(room, myPlayerIdRef.current || client.getPlayerId());
      },
      onPhysicsFull: (blocks) => {
        engineRef.current?.applyRemotePhysics(blocks, true);
      },
      onPhysicsDelta: (blocks) => {
        engineRef.current?.applyRemotePhysics(blocks, false);
      },
      onSfx: (sfx, intensity) => {
        engineRef.current?.playRemoteSfx(sfx, intensity);
      },
      onError: (message) => {
        setOnlineError(message);
        setOnlinePendingAction(false);
      },
      onHostClosed: (reason) => {
        setOnlineRoom(null);
        setOnlinePendingAction(false);
        prevOnlineStatusRef.current = null;
        prevOnlineTurnIdxRef.current = null;
        setGameOverResult(null);
        setTurnNotice(null);
        setMode('online');
        setOnlineError(reason);
        engineRef.current?.setOnlineMode(false);
      },
    });

    setMyPlayerId(client.getPlayerId());
    myPlayerIdRef.current = client.getPlayerId();
    onlineClientRef.current = client;

    return () => {
      client.dispose();
      onlineClientRef.current = null;
    };
  }, [showTurnNotice]);

  const updateSettings = (patch: Partial<UserSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const handleToggleSound = () => {
    woodAudio.unlock();
    const nextVal = !settings.soundEnabled;
    woodAudio.setEnabled(nextVal);
    updateSettings({ soundEnabled: nextVal });
  };

  const handleToggleGuide = () => {
    const nextVal = !settings.guideEnabled;
    engineRef.current?.setGuideEnabled(nextVal);
    updateSettings({ guideEnabled: nextVal });
  };

  const handleChangeHandedness = (handedness: Handedness) => {
    updateSettings({ handedness });
  };

  const handleStartGame = (chosenMode: GameMode, playerNames: string[]) => {
    woodAudio.unlock();
    if (onlineRoom) {
      onlineClientRef.current?.leaveRoom();
      setOnlineRoom(null);
    }
    engineRef.current?.setOnlineMode(false);
    setMode(chosenMode);
    const nextPlayers: PlayerInfo[] =
      chosenMode === 'pass_and_play'
        ? playerNames.map((name, idx) => ({
            id: `p_${idx}`,
            name,
            moves: 0,
            accentHex: PLAYER_ACCENTS[idx % PLAYER_ACCENTS.length],
          }))
        : [{ id: 'solo', name: 'ソロ', moves: 0, accentHex: PLAYER_ACCENTS[0] }];

    setPlayers(nextPlayers);
    setActivePlayerIdx(0);
    setGameOverResult(null);
    setTurnNotice(
      chosenMode === 'pass_and_play'
        ? `${nextPlayers[0].name} からスタート！`
        : '好きなブロックを指で引き抜いてみよう'
    );
    if (turnTimerRef.current) window.clearTimeout(turnTimerRef.current);
    turnTimerRef.current = window.setTimeout(() => setTurnNotice(null), 2600);

    engineRef.current?.startNewGame();
  };

  const handleCreateOnlineRoom = (playerName: string) => {
    woodAudio.unlock();
    setOnlineError(null);
    setOnlinePendingAction(true);
    onlineClientRef.current?.createRoom(playerName);
  };

  const handleJoinOnlineRoom = (roomCode: string, playerName: string) => {
    woodAudio.unlock();
    setOnlineError(null);
    setOnlinePendingAction(true);
    onlineClientRef.current?.joinRoom(roomCode, playerName);
  };

  const handleStartOnlineMatch = () => {
    woodAudio.unlock();
    if (!onlineRoom) return;
    onlineClientRef.current?.send({
      type: 'room:start',
      roomCode: onlineRoom.roomCode,
    });
  };

  const handleLeaveOnline = () => {
    onlineClientRef.current?.leaveRoom();
    setOnlineRoom(null);
    setOnlineError(null);
    setOnlinePendingAction(false);
    prevOnlineStatusRef.current = null;
    prevOnlineTurnIdxRef.current = null;
    setGameOverResult(null);
    setTurnNotice(null);
    setMode('solo');
    engineRef.current?.setOnlineMode(false);
    try {
      if (window.location.search.includes('room=')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    } catch {
      // Ignore history errors
    }
  };

  const handleRestart = () => {
    woodAudio.unlock();
    if (mode === 'online' && onlineRoom) {
      onlineClientRef.current?.send({
        type: 'room:restart',
        roomCode: onlineRoom.roomCode,
      });
      return;
    }
    setGameOverResult(null);
    setActivePlayerIdx(0);
    setPlayers((prev) => prev.map((p) => ({ ...p, moves: 0 })));
    engineRef.current?.startNewGame();
  };

  const handleOpenMenu = () => {
    if (mode === 'online') {
      handleLeaveOnline();
      return;
    }
    setGameOverResult(null);
    setTurnNotice(null);
    engineRef.current?.rebuildTower('menu');
  };

  const handleFocusZone = (zone: CameraFocusZone) => {
    engineRef.current?.focusCameraZone(zone, false);
  };

  const handleResetCamera = () => {
    engineRef.current?.resetCameraView();
  };

  const handleSelectSlot = (slot: 0 | 1 | 2) => {
    engineRef.current?.selectPlacementSlot(slot);
  };

  const handleConfirmPlace = () => {
    woodAudio.unlock();
    engineRef.current?.confirmPlaceBlock();
  };

  const handleSlide = (dir: -1 | 0 | 1) => {
    woodAudio.unlock();
    engineRef.current?.setManualSlide(dir);
  };

  const handleClearSelection = () => {
    engineRef.current?.clearBlockSelection();
  };

  const activeOnlinePlayer = useMemo(() => {
    if (mode !== 'online' || !onlineRoom) return null;
    const p = onlineRoom.players[onlineRoom.activePlayerIndex];
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      moves: p.moves,
      accentHex: p.accentHex,
    } satisfies PlayerInfo;
  }, [mode, onlineRoom]);

  const isOnlinePlaying = mode === 'online' && Boolean(onlineRoom);
  const isOnlineHost = Boolean(
    isOnlinePlaying && onlineRoom?.players.find((p) => p.id === myPlayerId)?.isHost
  );
  const isMyOnlineTurn = Boolean(
    isOnlinePlaying &&
      onlineRoom?.status === 'playing' &&
      onlineRoom.players[onlineRoom.activePlayerIndex]?.id === myPlayerId
  );
  const isSpectatingOnline = Boolean(
    isOnlinePlaying && onlineRoom?.status === 'playing' && !isMyOnlineTurn
  );

  const activePlayer =
    mode === 'online' ? activeOnlinePlayer : players[activePlayerIdx] ?? null;

  const showStartOverlay = snapshot.phase === 'menu' && !(mode === 'online' && onlineRoom);
  const showLobbyOverlay = mode === 'online' && onlineRoom?.status === 'lobby';

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#F4EFE6]">
      {/* Isolated WebGL 3D Canvas Container */}
      <div ref={canvasMountRef} className="fixed inset-0 z-0" />

      {/* Graceful WebGL Fallback */}
      {webglError && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-6 bg-[#F4EFE6]">
          <div className="max-w-sm rounded-2xl border border-[#241E19]/15 bg-[#FAF7F2] p-6 text-center shadow-lg">
            <h2 className="font-display text-lg font-bold text-[#241E19]">
              3Dビューを表示できません
            </h2>
            <p className="mt-2 text-sm text-[#5A4E43]">{webglError}</p>
          </div>
        </div>
      )}

      {/* Minimal Top HUD */}
      <TopHud
        mode={mode}
        phase={snapshot.phase}
        currentLayers={snapshot.currentLayers}
        extractedCount={snapshot.extractedCount}
        bestLayers={records.bestLayers}
        activePlayer={activePlayer}
        roomCode={onlineRoom?.roomCode ?? null}
        isMyOnlineTurn={isMyOnlineTurn}
        isOnlineHost={isOnlineHost}
        soundEnabled={settings.soundEnabled}
        onToggleSound={handleToggleSound}
        onRestart={handleRestart}
        onOpenMenu={handleOpenMenu}
        onLeaveOnline={handleLeaveOnline}
      />

      {/* Contextual Stability Guide / Phase / Spectator Banner */}
      <StabilityBanner
        phase={snapshot.phase}
        guideEnabled={settings.guideEnabled}
        stability={snapshot.stability}
        lockedNotice={snapshot.lockedNotice}
        turnNotice={turnNotice}
        isSpectatingOnline={isSpectatingOnline}
        activePlayerName={activePlayer?.name ?? null}
      />

      {/* One-Handed Ergonomic Bottom Dock */}
      <BottomDock
        phase={snapshot.phase}
        handedness={settings.handedness}
        guideEnabled={settings.guideEnabled}
        selectedSlot={snapshot.selectedSlot}
        availableSlots={snapshot.availableSlots}
        selectedBlockId={snapshot.selectedBlockId}
        canControl={mode !== 'online' || isMyOnlineTurn}
        onChangeHandedness={handleChangeHandedness}
        onToggleGuide={handleToggleGuide}
        onFocusZone={handleFocusZone}
        onResetCamera={handleResetCamera}
        onSelectSlot={handleSelectSlot}
        onConfirmPlace={handleConfirmPlace}
        onSlide={handleSlide}
        onClearSelection={handleClearSelection}
      />

      {/* Start / Mode Selection Overlay */}
      <StartOverlay
        visible={showStartOverlay}
        records={records}
        initialMode={mode}
        initialRoomCode={initialInviteCode}
        handedness={settings.handedness}
        onlineConnecting={onlinePendingAction || onlineStatus === 'connecting'}
        onlineError={onlineError}
        onChangeHandedness={handleChangeHandedness}
        onStartGame={handleStartGame}
        onCreateOnlineRoom={handleCreateOnlineRoom}
        onJoinOnlineRoom={handleJoinOnlineRoom}
      />

      {/* Online Multiplayer Lobby Overlay */}
      {showLobbyOverlay && (
        <OnlineLobbyOverlay
          room={onlineRoom}
          myPlayerId={myPlayerId}
          errorMsg={onlineError}
          onStartMatch={handleStartOnlineMatch}
          onLeaveRoom={handleLeaveOnline}
        />
      )}

      {/* Post-Collapse Result Modal */}
      <GameOverModal
        visible={snapshot.phase === 'gameover' && Boolean(gameOverResult)}
        mode={mode}
        finalLayers={gameOverResult?.finalLayers ?? snapshot.currentLayers}
        extractedCount={gameOverResult?.extractedCount ?? snapshot.extractedCount}
        loserName={gameOverResult?.loserName ?? null}
        winnerName={gameOverResult?.winnerName ?? null}
        isNewBestLayers={gameOverResult?.isNewBestLayers ?? false}
        isNewBestExtracted={gameOverResult?.isNewBestExtracted ?? false}
        records={records}
        isOnlineHost={isOnlineHost}
        onPlayAgain={handleRestart}
        onOpenMenu={handleOpenMenu}
        onLeaveOnline={handleLeaveOnline}
      />
    </main>
  );
}
