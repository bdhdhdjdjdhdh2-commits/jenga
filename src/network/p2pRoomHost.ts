import * as CANNON from 'cannon-es';
import {
  BLOCK_H,
  BLOCK_L,
  BLOCK_W,
  COASTER_TOP_Y,
  INITIAL_LAYERS,
  LAYER_GAP,
  type BlockTransformState,
  type ClientWsMessage,
  type OnlineRoomState,
  type RoomPlayer,
  type ServerWsMessage,
  type SfxEventType,
} from '../../shared/jengaProtocol';
import type { GamePhase, StabilityInfo, StabilityLevel } from '../types/game';

const PLAYER_ACCENTS = ['#C2592B', '#2C6E7F', '#2E7D4F', '#A16207'];

interface HostPlayer extends RoomPlayer {
  disconnectTimeout: ReturnType<typeof setTimeout> | null;
}

interface HostBlock {
  id: number;
  layer: number;
  slot: 0 | 1 | 2;
  baseMass: number;
  looseness: number;
  visible: boolean;
  body: CANNON.Body;
  lastSent: BlockTransformState | null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface P2PRoomHostCallbacks {
  onSendToPlayer: (playerId: string, msg: ServerWsMessage) => void;
  onBroadcastRemote?: (msg: ServerWsMessage) => void;
  onLocalEvent: (msg: ServerWsMessage) => void;
}

export class P2PRoomHost {
  public readonly roomCode: string;
  public readonly hostId: string;
  public status: 'lobby' | 'playing' | 'gameover' = 'lobby';
  public phase: GamePhase = 'menu';
  public players: HostPlayer[] = [];
  public activePlayerIndex = 0;
  public extractedCount = 0;
  public selectedBlockId: number | null = null;
  public activeBlockId: number | null = null;
  public selectedSlot: 0 | 1 | 2 = 1;
  public availableSlots: (0 | 1 | 2)[] = [0, 1, 2];
  public targetPlaceLayer = INITIAL_LAYERS;
  public lockedNotice: string | null = null;
  public winnerName: string | null = null;
  public loserName: string | null = null;

  private callbacks: P2PRoomHostCallbacks;
  private world!: CANNON.World;
  private blockPhysMat!: CANNON.Material;
  private pullingPhysMat!: CANNON.Material;
  private tablePhysMat!: CANNON.Material;
  private blocks: HostBlock[] = [];

  private isDraggingBlock = false;
  private dragStartWorldX = 0;
  private dragStartWorldZ = 0;
  private dragCurrentWorldX = 0;
  private dragCurrentWorldZ = 0;
  private dragStartBodyX = 0;
  private dragStartBodyZ = 0;
  private dragStartY = 0;
  private dragLongX = 0;
  private dragLongZ = 1;
  private dragLatX = 1;
  private dragLatZ = 0;

  private manualSlideDir: -1 | 0 | 1 = 0;
  private manualCamX = 7.2;
  private manualCamZ = 8.6;

  private lockedNoticeTimer = 0;
  private settleTimer = 0;
  private collapseTimer = 0;
  private timeScale = 1.0;
  private tickCounter = 0;
  private lastImpactAt = 0;
  private lastSlideAt = 0;
  private loopTimer: number | null = null;
  private lastStepTime = performance.now();

  constructor(
    roomCode: string,
    hostId: string,
    hostName: string,
    callbacks: P2PRoomHostCallbacks
  ) {
    this.roomCode = roomCode;
    this.hostId = hostId;
    this.callbacks = callbacks;

    this.players.push({
      id: hostId,
      name: hostName.trim().slice(0, 12) || 'ホスト',
      accentHex: PLAYER_ACCENTS[0],
      connected: true,
      moves: 0,
      isHost: true,
      disconnectTimeout: null,
    });

    this.rebuildTower('menu');
    this.lastStepTime = performance.now();
    this.loopTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - this.lastStepTime) / 1000, 0.05);
      this.lastStepTime = now;
      this.step(dt);
    }, 16);
  }

  private initPhysicsWorld(): void {
    this.world = new CANNON.World();
    this.world.gravity.set(0, -15.5, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.quatNormalizeFast = false;
    this.world.quatNormalizeSkip = 0;

    const solver = new CANNON.GSSolver();
    solver.iterations = 48;
    solver.tolerance = 0.0001;
    this.world.solver = solver;
    this.world.allowSleep = true;

    this.blockPhysMat = new CANNON.Material('woodBlock');
    this.pullingPhysMat = new CANNON.Material('pullingBlock');
    this.tablePhysMat = new CANNON.Material('craftTable');

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.blockPhysMat, this.blockPhysMat, {
        friction: 0.105,
        restitution: 0.01,
        contactEquationStiffness: 1.4e7,
        contactEquationRelaxation: 4,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.pullingPhysMat, this.blockPhysMat, {
        friction: 0.018,
        restitution: 0.0,
        contactEquationStiffness: 1.2e7,
        contactEquationRelaxation: 4,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.blockPhysMat, this.tablePhysMat, {
        friction: 0.42,
        restitution: 0.02,
        contactEquationStiffness: 1.4e7,
        contactEquationRelaxation: 4,
      })
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.pullingPhysMat, this.tablePhysMat, {
        friction: 0.03,
        restitution: 0.0,
        contactEquationStiffness: 1.2e7,
        contactEquationRelaxation: 4,
      })
    );

    const tableBody = new CANNON.Body({
      mass: 0,
      material: this.tablePhysMat,
      shape: new CANNON.Cylinder(5.6, 5.6, 0.32, 24),
      position: new CANNON.Vec3(0, -0.16, 0),
    });
    this.world.addBody(tableBody);

    const coasterBody = new CANNON.Body({
      mass: 0,
      material: this.tablePhysMat,
      shape: new CANNON.Cylinder(2.26, 2.28, 0.02, 24),
      position: new CANNON.Vec3(0, 0.01, 0),
    });
    this.world.addBody(coasterBody);
  }

  public rebuildTower(nextPhase: GamePhase): void {
    this.blocks = [];
    this.activeBlockId = null;
    this.selectedBlockId = null;
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;
    this.extractedCount = 0;
    this.timeScale = 1.0;
    this.settleTimer = 0;
    this.collapseTimer = 0;
    this.lockedNotice = null;
    this.winnerName = null;
    this.loserName = null;
    this.phase = nextPhase;

    this.initPhysicsWorld();

    const halfExtents = new CANNON.Vec3(BLOCK_W / 2, BLOCK_H / 2, BLOCK_L / 2);
    const boxShape = new CANNON.Box(halfExtents);

    let idCounter = 1;
    for (let layer = 0; layer < INITIAL_LAYERS; layer++) {
      const isOdd = layer % 2 === 1;
      const y = COASTER_TOP_Y + BLOCK_H / 2 + layer * BLOCK_H;

      for (let slot = 0 as 0 | 1 | 2; slot < 3; slot = (slot + 1) as 0 | 1 | 2) {
        const id = idCounter++;
        const offset = (slot - 1) * (BLOCK_W + LAYER_GAP);
        const jitterX = Math.sin(id * 12.9898) * 0.5 * 0.004;
        const jitterZ = Math.cos(id * 78.233) * 0.5 * 0.004;

        const x = isOdd ? jitterX : offset + jitterX;
        const z = isOdd ? offset + jitterZ : jitterZ;

        const baseMass = 1.45 + (((id * 17) % 9) - 4) * 0.008;
        const body = new CANNON.Body({
          mass: baseMass,
          material: this.blockPhysMat,
          shape: boxShape,
          position: new CANNON.Vec3(x, y, z),
          linearDamping: 0.28,
          angularDamping: 0.48,
          sleepSpeedLimit: 0.08,
          sleepTimeLimit: 0.45,
        });
        if (isOdd) {
          body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
        }
        body.sleep();

        body.addEventListener('collide', (e: { contact: CANNON.ContactEquation }) => {
          if (this.phase === 'menu' || this.status !== 'playing') return;
          const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
          if (impact > 0.55) {
            const now = performance.now();
            if (now - this.lastImpactAt > 45) {
              this.lastImpactAt = now;
              const norm = Math.min(1, (impact - 0.55) / 7.2);
              this.broadcastSfx('impact', norm);
            }
          }
        });

        this.world.addBody(body);
        this.blocks.push({
          id,
          layer,
          slot,
          baseMass,
          looseness: Math.abs(Math.sin(id * 4.37)),
          visible: true,
          body,
          lastSent: null,
        });
      }
    }
  }

  public addOrReconnectGuest(
    playerId: string,
    name: string
  ): { ok: true } | { ok: false; message: string } {
    const existing = this.players.find((p) => p.id === playerId);
    if (existing) {
      if (existing.disconnectTimeout) {
        clearTimeout(existing.disconnectTimeout);
        existing.disconnectTimeout = null;
      }
      existing.connected = true;
      if (name.trim()) existing.name = name.trim().slice(0, 12);
      return { ok: true };
    }

    if (this.status !== 'lobby') {
      return { ok: false, message: 'このルームはすでに対戦中です。' };
    }
    if (this.players.length >= 4) {
      return { ok: false, message: 'ルームが満員（最大4人）です。' };
    }

    const idx = this.players.length;
    this.players.push({
      id: playerId,
      name: name.trim().slice(0, 12) || `プレイヤー${idx + 1}`,
      accentHex: PLAYER_ACCENTS[idx % PLAYER_ACCENTS.length],
      connected: true,
      moves: 0,
      isHost: false,
      disconnectTimeout: null,
    });
    return { ok: true };
  }

  public handleGuestDisconnect(playerId: string): void {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.isHost) return;
    player.connected = false;

    if (this.status === 'lobby') {
      player.disconnectTimeout = setTimeout(() => {
        this.removeGuest(playerId);
      }, 6000);
    } else {
      player.disconnectTimeout = setTimeout(() => {
        const active = this.players[this.activePlayerIndex];
        if (active && active.id === playerId && !active.connected && this.status === 'playing') {
          this.advanceTurnToNextConnected();
          this.broadcastRoomState();
        }
      }, 12000);
    }
    this.broadcastRoomState();
  }

  public removeGuest(playerId: string): void {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1 || this.players[idx].isHost) return;
    const removed = this.players[idx];
    if (removed.disconnectTimeout) clearTimeout(removed.disconnectTimeout);
    this.players.splice(idx, 1);

    if (this.activePlayerIndex >= this.players.length) {
      this.activePlayerIndex = 0;
    }
    this.broadcastRoomState();
  }

  private advanceTurnToNextConnected(): void {
    if (this.players.length === 0) return;
    for (let i = 1; i <= this.players.length; i++) {
      const candidateIdx = (this.activePlayerIndex + i) % this.players.length;
      if (this.players[candidateIdx].connected) {
        this.activePlayerIndex = candidateIdx;
        return;
      }
    }
  }

  private getBlock(id: number | null): HostBlock | null {
    if (id === null) return null;
    return this.blocks.find((b) => b.id === id) ?? null;
  }

  private getMaxTowerLayer(): number {
    let maxL = 0;
    for (const b of this.blocks) {
      if (b.id === this.activeBlockId && this.phase === 'placing') continue;
      if (b.layer > maxL) maxL = b.layer;
    }
    return maxL;
  }

  private getTowerBlocksInLayer(layer: number): HostBlock[] {
    return this.blocks.filter(
      (b) => !(b.id === this.activeBlockId && this.phase === 'placing') && b.layer === layer
    );
  }

  private getTopLayerCenterXZ(layer: number): { x: number; z: number } {
    const layerBlocks = this.getTowerBlocksInLayer(layer);
    if (layerBlocks.length === 0) return { x: 0, z: 0 };
    let sx = 0;
    let sz = 0;
    for (const b of layerBlocks) {
      sx += b.body.position.x;
      sz += b.body.position.z;
    }
    return { x: sx / layerBlocks.length, z: sz / layerBlocks.length };
  }

  private getCurrentValidTowerLayers(): number {
    return this.getMaxTowerLayer() + 1;
  }

  private isBlockPullable(block: HostBlock): { ok: boolean; reason?: string } {
    const maxLayer = this.getMaxTowerLayer();
    const topCount = this.getTowerBlocksInLayer(maxLayer).length;

    if (block.layer >= maxLayer) {
      return { ok: false, reason: '最上段のブロックは抜けません' };
    }
    if (topCount < 3 && block.layer >= maxLayer - 1) {
      return { ok: false, reason: '最上段が3本そろうまで、その下の段は抜けません' };
    }
    return { ok: true };
  }

  private evaluateBlockStability(block: HostBlock): StabilityInfo {
    const check = this.isBlockPullable(block);
    if (!check.ok) {
      return {
        blockId: block.id,
        level: 'locked',
        label: '抜取不可',
        hint: check.reason || '上の段のため抜けません',
      };
    }

    const siblings = this.getTowerBlocksInLayer(block.layer);
    const count = siblings.length;
    const isMiddleSlot = block.slot === 1;

    let risk = 22;
    if (count === 3) {
      risk = isMiddleSlot ? 16 : 36;
    } else if (count === 2) {
      const hasLeft = siblings.some((s) => s.slot === 0);
      const hasCenter = siblings.some((s) => s.slot === 1);
      const hasRight = siblings.some((s) => s.slot === 2);

      if (hasLeft && hasRight && !hasCenter) {
        risk = 94;
      } else if (hasCenter) {
        risk = isMiddleSlot ? 92 : 52;
      }
    } else {
      risk = 99;
    }

    let leanSum = 0;
    let upperCount = 0;
    for (const b of this.blocks) {
      if (b.id !== this.activeBlockId && b.layer > block.layer) {
        leanSum += Math.hypot(b.body.position.x, b.body.position.z);
        upperCount++;
      }
    }
    const avgLean = upperCount > 0 ? leanSum / upperCount : 0;
    risk += Math.min(28, avgLean * 45);
    risk += block.looseness * 8 - 4;

    let level: StabilityLevel = 'safe';
    let label = '抜きやすい';
    let hint = '矢印方向へ引くか、下の引くボタンで抜けます';

    if (risk >= 70) {
      level = 'risky';
      label = '危険';
      hint = '片側支持または傾き大！崩れる恐れがあります';
    } else if (risk >= 42) {
      level = 'caution';
      label = '慎重に';
      hint = '矢印に沿ってゆっくり引き抜いてください';
    }

    return { blockId: block.id, level, label, hint };
  }

  private wakeAllBlocks(): void {
    for (const b of this.blocks) b.body.wakeUp();
  }

  private wakeNearbyLayers(minLayer: number): void {
    for (const b of this.blocks) {
      if (b.layer >= minLayer) b.body.wakeUp();
    }
  }

  private computeBlockAxes(block: HostBlock): void {
    const q = block.body.quaternion;
    const x = 2 * (q.x * q.z + q.w * q.y);
    const z = 1 - 2 * (q.x * q.x + q.y * q.y);
    const len = Math.hypot(x, z) || 1;
    this.dragLongX = x / len;
    this.dragLongZ = z / len;
    this.dragLatX = -this.dragLongZ;
    this.dragLatZ = this.dragLongX;
  }

  public handleMessage(senderId: string, msg: ClientWsMessage): void {
    const sender = this.players.find((p) => p.id === senderId);
    if (!sender) return;

    if (msg.type === 'room:start') {
      if (!sender.isHost || this.players.filter((p) => p.connected).length < 2) return;
      this.players.forEach((p) => {
        p.moves = 0;
      });
      this.activePlayerIndex = 0;
      this.status = 'playing';
      this.rebuildTower('inspect');
      this.broadcastFullPhysics();
      this.broadcastRoomState();
      return;
    }

    if (msg.type === 'room:restart') {
      if (!sender.isHost) return;
      this.players.forEach((p) => {
        p.moves = 0;
      });
      this.activePlayerIndex = 0;
      this.status = 'playing';
      this.rebuildTower('inspect');
      this.broadcastFullPhysics();
      this.broadcastRoomState();
      return;
    }

    if (this.status !== 'playing') return;
    const activePlayer = this.players[this.activePlayerIndex];
    if (!activePlayer || activePlayer.id !== senderId) return;

    switch (msg.type) {
      case 'game:select_block': {
        if (this.phase !== 'inspect') return;
        this.selectedBlockId = msg.blockId;
        this.manualSlideDir = 0;
        this.broadcastRoomState();
        break;
      }

      case 'game:drag_start': {
        if (this.phase !== 'inspect') return;
        const block = this.getBlock(msg.blockId);
        if (!block) return;

        const pullCheck = this.isBlockPullable(block);
        if (!pullCheck.ok) {
          this.lockedNotice = pullCheck.reason || 'このブロックは抜けません';
          this.lockedNoticeTimer = 2.0;
          this.broadcastSfx('locked', 0.2);
          this.broadcastRoomState();
          return;
        }

        this.lockedNotice = null;
        this.activeBlockId = block.id;
        this.selectedBlockId = block.id;
        this.isDraggingBlock = true;
        this.manualSlideDir = 0;
        this.phase = 'pulling';

        block.body.material = this.pullingPhysMat;
        this.wakeAllBlocks();
        this.computeBlockAxes(block);

        this.dragStartY = block.body.position.y;
        this.dragStartBodyX = block.body.position.x;
        this.dragStartBodyZ = block.body.position.z;
        this.dragStartWorldX = msg.targetX;
        this.dragStartWorldZ = msg.targetZ;
        this.dragCurrentWorldX = msg.targetX;
        this.dragCurrentWorldZ = msg.targetZ;
        this.broadcastRoomState();
        break;
      }

      case 'game:drag_move': {
        if (this.phase !== 'pulling' || !this.isDraggingBlock) return;
        this.dragCurrentWorldX = msg.targetX;
        this.dragCurrentWorldZ = msg.targetZ;
        break;
      }

      case 'game:drag_end': {
        if (this.phase === 'pulling' && this.isDraggingBlock) {
          this.isDraggingBlock = false;
          const b = this.getBlock(this.activeBlockId);
          if (b) {
            b.body.material = this.blockPhysMat;
            b.body.velocity.scale(0.08, b.body.velocity);
            b.body.angularVelocity.set(0, 0, 0);
          }
          this.activeBlockId = null;
          this.phase = 'inspect';
          this.broadcastRoomState();
        }
        break;
      }

      case 'game:manual_slide': {
        if (this.phase !== 'inspect' && this.phase !== 'pulling') return;
        const sb = this.getBlock(this.selectedBlockId);
        if (!sb) {
          this.manualSlideDir = 0;
          return;
        }
        if (msg.dir === 0) {
          if (this.manualSlideDir !== 0) {
            sb.body.material = this.blockPhysMat;
            sb.body.velocity.scale(0.08, sb.body.velocity);
            sb.body.angularVelocity.set(0, 0, 0);
          }
          this.manualSlideDir = 0;
          if (this.phase === 'pulling' && !this.isDraggingBlock) {
            this.phase = 'inspect';
            this.activeBlockId = null;
            this.broadcastRoomState();
          }
          return;
        }
        const check = this.isBlockPullable(sb);
        if (!check.ok) return;

        this.manualSlideDir = msg.dir;
        this.manualCamX = msg.camX;
        this.manualCamZ = msg.camZ;
        this.activeBlockId = sb.id;
        sb.body.material = this.pullingPhysMat;
        this.dragStartY = sb.body.position.y;
        this.phase = 'pulling';
        this.wakeAllBlocks();
        this.broadcastRoomState();
        break;
      }

      case 'game:select_slot': {
        if (this.phase !== 'placing') return;
        if (!this.availableSlots.includes(msg.slot)) return;
        this.selectedSlot = msg.slot;
        this.broadcastRoomState();
        break;
      }

      case 'game:confirm_place': {
        if (this.phase !== 'placing') return;
        const block = this.getBlock(this.activeBlockId);
        if (!block || !this.availableSlots.includes(this.selectedSlot)) return;

        const targetLayer = this.targetPlaceLayer;
        const slot = this.selectedSlot;
        const isOdd = targetLayer % 2 === 1;
        const offset = (slot - 1) * (BLOCK_W + LAYER_GAP);
        const center = this.getTopLayerCenterXZ(targetLayer - 1);

        const x = isOdd ? center.x : center.x + offset;
        const z = isOdd ? center.z + offset : center.z;
        const y = COASTER_TOP_Y + BLOCK_H / 2 + targetLayer * BLOCK_H + 0.1;

        block.layer = targetLayer;
        block.slot = slot;
        block.visible = true;
        block.body.material = this.blockPhysMat;
        block.body.type = CANNON.Body.DYNAMIC;
        block.body.mass = block.baseMass;
        block.body.updateMassProperties();
        block.body.collisionResponse = true;
        block.body.position.set(x, y, z);
        block.body.velocity.set(0, -0.3, 0);
        block.body.angularVelocity.set(0, 0, 0);
        block.body.quaternion.set(0, 0, 0, 1);
        if (isOdd) {
          block.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
        }
        block.body.wakeUp();

        this.wakeNearbyLayers(targetLayer - 2);
        this.activeBlockId = null;
        this.selectedBlockId = null;
        this.phase = 'settling';
        this.settleTimer = 1.15;
        this.broadcastSfx('impact', 0.42);
        this.broadcastRoomState();
        break;
      }
    }
  }

  private enterPlacingPhase(block: HostBlock): void {
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;
    this.phase = 'placing';
    this.extractedCount += 1;
    this.broadcastSfx('extract', 1.0);

    block.body.material = this.blockPhysMat;
    block.body.type = CANNON.Body.KINEMATIC;
    block.body.collisionResponse = false;
    block.body.velocity.set(0, 0, 0);
    block.body.angularVelocity.set(0, 0, 0);
    block.body.position.set(0, -25, 0);
    block.visible = false;
    this.selectedBlockId = null;

    const maxLayer = this.getMaxTowerLayer();
    const topBlocks = this.getTowerBlocksInLayer(maxLayer);
    if (topBlocks.length < 3) {
      this.targetPlaceLayer = maxLayer;
      const occupied = new Set(topBlocks.map((b) => b.slot));
      this.availableSlots = ([0, 1, 2] as (0 | 1 | 2)[]).filter((s) => !occupied.has(s));
    } else {
      this.targetPlaceLayer = maxLayer + 1;
      this.availableSlots = [0, 1, 2];
    }

    this.selectedSlot = this.availableSlots.includes(1) ? 1 : this.availableSlots[0];
    this.broadcastDeltaPhysics(true);
    this.broadcastRoomState();
  }

  private triggerCollapse(): void {
    if (this.phase === 'collapsing' || this.phase === 'gameover') return;
    this.phase = 'collapsing';
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;

    const active = this.getBlock(this.activeBlockId);
    if (active) {
      active.body.material = this.blockPhysMat;
      active.body.type = CANNON.Body.DYNAMIC;
      active.body.collisionResponse = true;
      this.activeBlockId = null;
    }
    this.selectedBlockId = null;

    this.wakeAllBlocks();
    this.timeScale = 0.28;
    this.collapseTimer = 2.6;
    this.broadcastSfx('collapse', 1.0);
    this.broadcastRoomState();
  }

  private checkTowerCollapse(): boolean {
    if (this.status !== 'playing' || this.phase === 'collapsing' || this.phase === 'gameover') {
      return false;
    }

    let fallenCount = 0;
    for (const b of this.blocks) {
      if (b.id === this.activeBlockId || b.id === this.selectedBlockId) continue;

      const py = b.body.position.y;
      const expectedY = COASTER_TOP_Y + BLOCK_H / 2 + b.layer * BLOCK_H;

      if (b.layer >= 1 && py < BLOCK_H * 0.92) {
        return true;
      }
      if (b.layer >= 2 && expectedY - py > BLOCK_H * 1.9) {
        fallenCount++;
      }
      if (b.layer === 0 && Math.hypot(b.body.position.x, b.body.position.z) > 2.65) {
        return true;
      }
    }
    return fallenCount >= 2;
  }

  private step(rawDelta: number): void {
    if (this.status === 'lobby') return;

    if (this.lockedNotice && this.lockedNoticeTimer > 0) {
      this.lockedNoticeTimer -= rawDelta;
      if (this.lockedNoticeTimer <= 0) {
        this.lockedNotice = null;
        this.broadcastRoomState();
      }
    }

    if (this.phase === 'pulling' && this.activeBlockId !== null) {
      const b = this.getBlock(this.activeBlockId);
      if (b) {
        b.body.wakeUp();
        if (this.isDraggingBlock) {
          const dWorldX = this.dragCurrentWorldX - this.dragStartWorldX;
          const dWorldZ = this.dragCurrentWorldZ - this.dragStartWorldZ;
          const longDist = dWorldX * this.dragLongX + dWorldZ * this.dragLongZ;
          const latDist = (dWorldX * this.dragLatX + dWorldZ * this.dragLatZ) * 0.08;

          const targetX = this.dragStartBodyX + this.dragLongX * longDist + this.dragLatX * latDist;
          const targetZ = this.dragStartBodyZ + this.dragLongZ * longDist + this.dragLatZ * latDist;

          const dx = targetX - b.body.position.x;
          const dz = targetZ - b.body.position.z;
          const dy = Math.max(this.dragStartY, b.body.position.y) - b.body.position.y;

          const gain = 10.5;
          const maxSpeed = 3.8;
          let vx = dx * gain;
          let vz = dz * gain;
          const speed = Math.hypot(vx, vz);
          if (speed > maxSpeed) {
            const s = maxSpeed / speed;
            vx *= s;
            vz *= s;
          }
          b.body.velocity.set(vx, Math.max(-0.12, dy * 5), vz);
          b.body.angularVelocity.set(0, 0, 0);

          if (speed > 0.45 && performance.now() - this.lastSlideAt > 85) {
            this.lastSlideAt = performance.now();
            this.broadcastSfx('slide', clamp(speed / 4, 0.2, 1));
          }
        } else if (this.manualSlideDir !== 0) {
          this.computeBlockAxes(b);
          const camVecX = b.body.position.x - this.manualCamX;
          const camVecZ = b.body.position.z - this.manualCamZ;
          const dotCam = this.dragLongX * camVecX + this.dragLongZ * camVecZ;
          const towardCamSign = dotCam > 0 ? -1 : 1;
          const slideSign = towardCamSign * this.manualSlideDir;
          const slideSpeed = 2.4;
          const dy = Math.max(this.dragStartY, b.body.position.y) - b.body.position.y;

          b.body.velocity.set(
            this.dragLongX * slideSign * slideSpeed,
            Math.max(-0.1, dy * 6),
            this.dragLongZ * slideSign * slideSpeed
          );
          b.body.angularVelocity.set(0, 0, 0);

          if (performance.now() - this.lastSlideAt > 85) {
            this.lastSlideAt = performance.now();
            this.broadcastSfx('slide', 0.65);
          }
        }

        const center = this.getTopLayerCenterXZ(b.layer);
        const radialDist = Math.hypot(b.body.position.x - center.x, b.body.position.z - center.z);
        if (radialDist > BLOCK_L * 0.9) {
          this.enterPlacingPhase(b);
        }
      }
    }

    if (this.phase === 'inspect' && this.selectedBlockId !== null) {
      const sb = this.getBlock(this.selectedBlockId);
      if (sb) {
        const center = this.getTopLayerCenterXZ(sb.layer);
        const radialDist = Math.hypot(
          sb.body.position.x - center.x,
          sb.body.position.z - center.z
        );
        const expectedY = COASTER_TOP_Y + BLOCK_H / 2 + sb.layer * BLOCK_H;
        if (radialDist > BLOCK_L * 0.7 && sb.body.position.y < expectedY - BLOCK_H * 0.32) {
          this.activeBlockId = sb.id;
          this.enterPlacingPhase(sb);
        }
      }
    }

    const scaledDt = rawDelta * this.timeScale;
    this.world.step(1 / 240, scaledDt, 10);

    if (
      (this.phase === 'inspect' ||
        this.phase === 'pulling' ||
        this.phase === 'placing' ||
        this.phase === 'settling') &&
      this.checkTowerCollapse()
    ) {
      this.triggerCollapse();
    }

    if (this.phase === 'settling') {
      this.settleTimer -= rawDelta;
      if (this.settleTimer <= 0) {
        this.phase = 'inspect';
        const curPlayer = this.players[this.activePlayerIndex];
        if (curPlayer) curPlayer.moves += 1;
        this.advanceTurnToNextConnected();
        this.broadcastSfx('place', 1.0);
        this.broadcastRoomState();
      }
    }

    if (this.phase === 'collapsing') {
      this.collapseTimer -= rawDelta;
      if (this.collapseTimer <= 0) {
        this.timeScale = 1.0;
        this.phase = 'gameover';
        this.status = 'gameover';
        const loser = this.players[this.activePlayerIndex] ?? null;
        const prevIdx =
          this.players.length > 1
            ? (this.activePlayerIndex - 1 + this.players.length) % this.players.length
            : 0;
        const winner = this.players.length > 1 ? this.players[prevIdx] : null;
        this.loserName = loser ? loser.name : null;
        this.winnerName = winner ? winner.name : null;
        this.broadcastRoomState();
      }
    }

    this.tickCounter++;
    if (this.tickCounter % 2 === 0) {
      this.broadcastDeltaPhysics(false);
    }
  }

  public getBlocksSnapshot(): BlockTransformState[] {
    return this.blocks.map((b) => ({
      id: b.id,
      layer: b.layer,
      slot: b.slot,
      x: Number(b.body.position.x.toFixed(4)),
      y: Number(b.body.position.y.toFixed(4)),
      z: Number(b.body.position.z.toFixed(4)),
      qx: Number(b.body.quaternion.x.toFixed(4)),
      qy: Number(b.body.quaternion.y.toFixed(4)),
      qz: Number(b.body.quaternion.z.toFixed(4)),
      qw: Number(b.body.quaternion.w.toFixed(4)),
      visible: b.visible,
    }));
  }

  public getRoomState(): OnlineRoomState {
    const focusBlock =
      this.getBlock(this.activeBlockId) ?? this.getBlock(this.selectedBlockId);
    const stability = focusBlock ? this.evaluateBlockStability(focusBlock) : null;

    return {
      roomCode: this.roomCode,
      status: this.status,
      phase: this.phase,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        accentHex: p.accentHex,
        connected: p.connected,
        moves: p.moves,
        isHost: p.isHost,
      })),
      activePlayerIndex: this.activePlayerIndex,
      currentLayers: this.getCurrentValidTowerLayers(),
      extractedCount: this.extractedCount,
      selectedBlockId: this.selectedBlockId,
      activeBlockId: this.activeBlockId,
      selectedSlot: this.selectedSlot,
      availableSlots: [...this.availableSlots],
      targetPlaceLayer: this.targetPlaceLayer,
      stability,
      lockedNotice: this.lockedNotice,
      winnerName: this.winnerName,
      loserName: this.loserName,
    };
  }

  private sendToAll(msg: ServerWsMessage): void {
    const hostPlayer = this.players.find((p) => p.id === this.hostId);
    if (hostPlayer?.connected) {
      this.callbacks.onLocalEvent(msg);
    }
    if (this.callbacks.onBroadcastRemote) {
      this.callbacks.onBroadcastRemote(msg);
      return;
    }
    for (const p of this.players) {
      if (!p.connected || p.id === this.hostId) continue;
      this.callbacks.onSendToPlayer(p.id, msg);
    }
  }

  public broadcastRoomState(): void {
    this.sendToAll({ type: 'room:state', room: this.getRoomState() });
  }

  public broadcastFullPhysics(): void {
    const snap = this.getBlocksSnapshot();
    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].lastSent = snap[i];
    }
    this.sendToAll({ type: 'physics:full', blocks: snap });
  }

  private broadcastDeltaPhysics(forceAll: boolean): void {
    const changed: BlockTransformState[] = [];
    for (const b of this.blocks) {
      const next: BlockTransformState = {
        id: b.id,
        layer: b.layer,
        slot: b.slot,
        x: Number(b.body.position.x.toFixed(4)),
        y: Number(b.body.position.y.toFixed(4)),
        z: Number(b.body.position.z.toFixed(4)),
        qx: Number(b.body.quaternion.x.toFixed(4)),
        qy: Number(b.body.quaternion.y.toFixed(4)),
        qz: Number(b.body.quaternion.z.toFixed(4)),
        qw: Number(b.body.quaternion.w.toFixed(4)),
        visible: b.visible,
      };

      const prev = b.lastSent;
      if (
        forceAll ||
        !prev ||
        prev.visible !== next.visible ||
        prev.layer !== next.layer ||
        prev.slot !== next.slot ||
        Math.abs(prev.x - next.x) > 0.0015 ||
        Math.abs(prev.y - next.y) > 0.0015 ||
        Math.abs(prev.z - next.z) > 0.0015 ||
        Math.abs(prev.qx - next.qx) > 0.002 ||
        Math.abs(prev.qy - next.qy) > 0.002 ||
        Math.abs(prev.qz - next.qz) > 0.002 ||
        Math.abs(prev.qw - next.qw) > 0.002
      ) {
        b.lastSent = next;
        changed.push(next);
      }
    }

    if (changed.length > 0) {
      this.sendToAll({ type: 'physics:delta', blocks: changed });
    }
  }

  private broadcastSfx(sfx: SfxEventType, intensity?: number): void {
    this.sendToAll({ type: 'sfx:event', sfx, intensity });
  }

  public dispose(): void {
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    for (const p of this.players) {
      if (p.disconnectTimeout) {
        clearTimeout(p.disconnectTimeout);
        p.disconnectTimeout = null;
      }
    }
  }
}
