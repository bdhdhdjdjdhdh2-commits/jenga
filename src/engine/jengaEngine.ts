import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { woodAudio } from '../audio/woodAudio';
import { buildStudioScene, detectSoftwareWebGL } from '../three/studioScene';
import { createBlockMaterialPool } from '../three/woodMaterials';
import type {
  BlockTransformState,
  ClientWsMessage,
  OnlineRoomState,
  SfxEventType,
} from '../../shared/jengaProtocol';
import type {
  CameraFocusZone,
  GamePhase,
  StabilityInfo,
  StabilityLevel,
  TowerSnapshot,
} from '../types/game';

export const BLOCK_W = 0.8;
export const BLOCK_H = 0.48;
export const BLOCK_L = 2.4;
const INITIAL_LAYERS = 18;
const COASTER_TOP_Y = 0.02;
const LAYER_GAP = 0.018;

interface BlockEntity {
  id: number;
  layer: number;
  slot: 0 | 1 | 2;
  baseMass: number;
  looseness: number;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  body: CANNON.Body;
  remotePos: THREE.Vector3;
  remoteQuat: THREE.Quaternion;
}

interface GhostSlot {
  slot: 0 | 1 | 2;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  available: boolean;
}

export interface JengaEngineCallbacks {
  onSnapshot: (snapshot: TowerSnapshot) => void;
  onTurnComplete: (newLayers: number, extractedCount: number) => void;
  onCollapse: (finalLayers: number, extractedCount: number) => void;
  onOnlineInput?: (msg: ClientWsMessage) => void;
}

// Reusable scratch math objects (Zero GC in render loop)
const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _longDir = new THREE.Vector3();
const _latDir = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _rayHit = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);

export class JengaEngine {
  private container: HTMLElement;
  private callbacks: JengaEngineCallbacks;

  private isSoftwareGl: boolean;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private studioRig: ReturnType<typeof buildStudioScene>;
  private blockMaterialsPool: ReturnType<typeof createBlockMaterialPool>;
  private blockGeometry: RoundedBoxGeometry;

  private world!: CANNON.World;
  private blockPhysMat!: CANNON.Material;
  private pullingPhysMat!: CANNON.Material;
  private tablePhysMat!: CANNON.Material;
  private blocks: BlockEntity[] = [];
  private bodyToBlock = new Map<number, BlockEntity>();

  private ghostSlots: GhostSlot[] = [];
  private ghostGeometry: RoundedBoxGeometry;
  private previewBlockMesh: THREE.Mesh;
  private pullArrowGroup: THREE.Group;
  private pullArrowForward: THREE.Mesh;
  private pullArrowBackward: THREE.Mesh;

  private phase: GamePhase = 'menu';
  private guideEnabled = true;
  private hapticsEnabled = true;
  private extractedCount = 0;

  private activeBlock: BlockEntity | null = null;
  private selectedBlock: BlockEntity | null = null;
  private hoveredBlock: BlockEntity | null = null;
  private selectedSlot: 0 | 1 | 2 = 1;
  private targetPlaceLayer = INITIAL_LAYERS;
  private availableSlots: (0 | 1 | 2)[] = [0, 1, 2];

  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2();
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragStartWorld = new THREE.Vector3();
  private dragStartBodyPos = new THREE.Vector3();
  private dragCurrentWorld = new THREE.Vector3();
  private dragLongAxis = new THREE.Vector3(0, 0, 1);
  private dragLatAxis = new THREE.Vector3(1, 0, 0);
  private dragStartY = 0;
  private pointerDownClientX = 0;
  private pointerDownClientY = 0;
  private pointerDownTime = 0;
  private isDraggingBlock = false;
  private manualSlideDir: -1 | 0 | 1 = 0; // -1: push away, +1: pull toward camera

  private lastTapGhostSlot: 0 | 1 | 2 | null = null;
  private lastTapTime = 0;

  private lockedNotice: string | null = null;
  private lockedNoticeTimer = 0;
  private settleTimer = 0;
  private collapseTimer = 0;
  private timeScale = 1.0;

  private desiredCamTargetY = 4.2;
  private cameraTransitionActive = false;
  private desiredCamPos = new THREE.Vector3();

  private clock = new THREE.Clock();
  private frameId = 0;
  private disposed = false;

  private onlineMode = false;
  private isMyOnlineTurn = false;
  private lastOnlineDragSentAt = 0;
  private remoteStability: StabilityInfo | null = null;

  constructor(container: HTMLElement, callbacks: JengaEngineCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.isSoftwareGl = detectSoftwareWebGL();
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'w-full h-full block touch-canvas outline-none';

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120);
    this.camera.position.set(7.2, 7.6, 8.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 5.2;
    this.controls.maxDistance = 18.5;
    this.controls.minPolarAngle = 0.22;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.target.set(0, 4.2, 0);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.85;

    this.controls.addEventListener('start', () => {
      this.cameraTransitionActive = false;
    });

    this.studioRig = buildStudioScene(this.scene, this.renderer, this.isSoftwareGl);
    this.blockMaterialsPool = createBlockMaterialPool(this.renderer);
    this.blockGeometry = new RoundedBoxGeometry(BLOCK_W, BLOCK_H, BLOCK_L, 2, 0.032);
    this.ghostGeometry = new RoundedBoxGeometry(
      BLOCK_W * 0.96,
      BLOCK_H * 0.94,
      BLOCK_L * 0.98,
      1,
      0.02
    );

    const previewMat = new THREE.MeshStandardMaterial({
      color: '#DFB684',
      roughness: 0.55,
      metalness: 0.04,
      transparent: true,
      opacity: 0.88,
      emissive: new THREE.Color('#C2592B'),
      emissiveIntensity: 0.16,
    });
    this.previewBlockMesh = new THREE.Mesh(this.blockGeometry, previewMat);
    this.previewBlockMesh.visible = false;
    this.previewBlockMesh.castShadow = !this.isSoftwareGl;
    this.scene.add(this.previewBlockMesh);

    // 3D pull-direction guide arrows shown at both ends of a selected/hovered block
    this.pullArrowGroup = new THREE.Group();
    this.pullArrowGroup.visible = false;
    const arrowGeo = new THREE.ConeGeometry(0.16, 0.36, 16);
    const arrowMat = new THREE.MeshBasicMaterial({
      color: '#C2592B',
      transparent: true,
      opacity: 0.9,
    });
    this.pullArrowForward = new THREE.Mesh(arrowGeo, arrowMat);
    this.pullArrowForward.rotation.x = Math.PI / 2;
    this.pullArrowForward.position.set(0, 0, BLOCK_L / 2 + 0.34);

    this.pullArrowBackward = new THREE.Mesh(arrowGeo, arrowMat);
    this.pullArrowBackward.rotation.x = -Math.PI / 2;
    this.pullArrowBackward.position.set(0, 0, -(BLOCK_L / 2 + 0.34));

    this.pullArrowGroup.add(this.pullArrowForward, this.pullArrowBackward);
    this.scene.add(this.pullArrowGroup);

    this.initGhostSlots();
    this.rebuildTower('menu');

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.startLoop();
  }

  private initGhostSlots(): void {
    for (let s = 0 as 0 | 1 | 2; s < 3; s = (s + 1) as 0 | 1 | 2) {
      const mat = new THREE.MeshBasicMaterial({
        color: '#C2592B',
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ghostGeometry, mat);
      mesh.visible = false;
      mesh.userData.ghostSlot = s;
      this.scene.add(mesh);
      this.ghostSlots.push({ slot: s, mesh, material: mat, available: true });
    }
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

    // Resting block-to-block: low sliding friction + crisp stiff contacts to prevent wedging
    const blockToBlock = new CANNON.ContactMaterial(this.blockPhysMat, this.blockPhysMat, {
      friction: 0.105,
      restitution: 0.01,
      contactEquationStiffness: 1.4e7,
      contactEquationRelaxation: 4,
    });
    // Active pulled block: ultra-low friction so adjacent/upper blocks are never dragged along
    const pullingToBlock = new CANNON.ContactMaterial(this.pullingPhysMat, this.blockPhysMat, {
      friction: 0.018,
      restitution: 0.0,
      contactEquationStiffness: 1.2e7,
      contactEquationRelaxation: 4,
    });
    const blockToTable = new CANNON.ContactMaterial(this.blockPhysMat, this.tablePhysMat, {
      friction: 0.42,
      restitution: 0.02,
      contactEquationStiffness: 1.4e7,
      contactEquationRelaxation: 4,
    });
    const pullingToTable = new CANNON.ContactMaterial(this.pullingPhysMat, this.tablePhysMat, {
      friction: 0.03,
      restitution: 0.0,
      contactEquationStiffness: 1.2e7,
      contactEquationRelaxation: 4,
    });

    this.world.addContactMaterial(blockToBlock);
    this.world.addContactMaterial(pullingToBlock);
    this.world.addContactMaterial(blockToTable);
    this.world.addContactMaterial(pullingToTable);

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
    for (const block of this.blocks) {
      this.scene.remove(block.mesh);
      block.material.dispose();
    }
    this.blocks = [];
    this.bodyToBlock.clear();
    this.activeBlock = null;
    this.selectedBlock = null;
    this.hoveredBlock = null;
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;
    this.extractedCount = 0;
    this.timeScale = 1.0;
    this.settleTimer = 0;
    this.collapseTimer = 0;
    this.lockedNotice = null;
    this.pullArrowGroup.visible = false;
    this.hideGhostSlots();

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

        const baseMat =
          this.blockMaterialsPool.materials[
            (id + layer) % this.blockMaterialsPool.materials.length
          ];
        const material = baseMat.clone();
        const mesh = new THREE.Mesh(this.blockGeometry, material);
        mesh.castShadow = !this.isSoftwareGl;
        mesh.receiveShadow = true;
        mesh.userData.blockId = id;
        mesh.position.set(x, y, z);
        if (isOdd) {
          mesh.rotation.y = Math.PI / 2;
        }
        this.scene.add(mesh);

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

        const entity: BlockEntity = {
          id,
          layer,
          slot,
          baseMass,
          looseness: Math.abs(Math.sin(id * 4.37)),
          mesh,
          material,
          body,
          remotePos: new THREE.Vector3(x, y, z),
          remoteQuat: new THREE.Quaternion().copy(mesh.quaternion),
        };

        body.addEventListener('collide', (e: { contact: CANNON.ContactEquation }) => {
          if (this.phase === 'menu') return;
          const impact = Math.abs(e.contact.getImpactVelocityAlongNormal());
          if (impact > 0.45) {
            const norm = Math.min(1, (impact - 0.45) / 7.5);
            woodAudio.playWoodImpact(norm, (id % 5) * 14 - 28);
          }
        });

        this.world.addBody(body);
        this.blocks.push(entity);
        this.bodyToBlock.set(body.id, entity);
      }
    }

    this.phase = nextPhase;
    this.controls.autoRotate = nextPhase === 'menu';
    this.controls.enabled = true;
    this.focusCameraZone('mid', true);
    this.emitSnapshot();
  }

  public startNewGame(): void {
    this.rebuildTower('inspect');
  }

  public setGuideEnabled(enabled: boolean): void {
    this.guideEnabled = enabled;
    this.refreshBlockHighlights();
    this.emitSnapshot();
  }

  public setHapticsEnabled(enabled: boolean): void {
    this.hapticsEnabled = enabled;
  }

  public setOnlineMode(enabled: boolean): void {
    this.onlineMode = enabled;
    this.isMyOnlineTurn = false;
    this.remoteStability = null;
    if (!enabled) {
      this.rebuildTower('menu');
    } else {
      this.rebuildTower('menu');
      this.controls.autoRotate = true;
      this.controls.enabled = true;
    }
  }

  public applyRemotePhysics(blocksState: BlockTransformState[], immediate: boolean): void {
    if (!this.onlineMode) return;
    for (const s of blocksState) {
      const entity = this.blocks.find((b) => b.id === s.id);
      if (!entity) continue;
      entity.layer = s.layer;
      entity.slot = s.slot;
      entity.mesh.visible = s.visible;
      entity.remotePos.set(s.x, s.y, s.z);
      entity.remoteQuat.set(s.qx, s.qy, s.qz, s.qw);
      entity.body.position.set(s.x, s.y, s.z);
      entity.body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      if (immediate) {
        entity.mesh.position.copy(entity.remotePos);
        entity.mesh.quaternion.copy(entity.remoteQuat);
      }
    }
  }

  public applyRemoteRoomState(room: OnlineRoomState, myPlayerId: string): void {
    if (!this.onlineMode) return;
    const prevPhase = this.phase;
    const activePlayer = room.players[room.activePlayerIndex];
    this.isMyOnlineTurn = room.status === 'playing' && activePlayer?.id === myPlayerId;

    this.phase = room.status === 'lobby' ? 'menu' : room.phase;
    this.extractedCount = room.extractedCount;
    this.selectedSlot = room.selectedSlot;
    this.availableSlots = [...room.availableSlots];
    this.targetPlaceLayer = room.targetPlaceLayer;
    this.lockedNotice = room.lockedNotice;
    this.remoteStability = room.stability;

    this.selectedBlock =
      room.selectedBlockId !== null
        ? this.blocks.find((b) => b.id === room.selectedBlockId) ?? null
        : null;
    this.activeBlock =
      room.activeBlockId !== null
        ? this.blocks.find((b) => b.id === room.activeBlockId) ?? null
        : null;

    if (this.phase === 'menu') {
      this.controls.autoRotate = true;
      this.controls.enabled = true;
      this.hideGhostSlots();
      this.previewBlockMesh.visible = false;
    } else if (this.phase === 'placing') {
      this.controls.autoRotate = false;
      this.controls.enabled = true;
      this.updateGhostSlotVisuals();
      if (prevPhase !== 'placing') {
        this.focusCameraZone('top', false);
      }
    } else if (this.phase === 'collapsing') {
      this.controls.autoRotate = false;
      this.controls.enabled = false;
      this.hideGhostSlots();
      this.previewBlockMesh.visible = false;
      this.pullArrowGroup.visible = false;
      if (prevPhase !== 'collapsing') {
        this.collapseTimer = 2.6;
        if (this.hapticsEnabled && 'vibrate' in navigator) {
          navigator.vibrate([45, 35, 85]);
        }
      }
    } else if (this.phase === 'gameover') {
      this.controls.enabled = true;
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.5;
      this.hideGhostSlots();
      this.previewBlockMesh.visible = false;
      this.pullArrowGroup.visible = false;
    } else {
      this.controls.autoRotate = false;
      if (!this.isDraggingBlock) {
        this.controls.enabled = true;
      }
      this.hideGhostSlots();
      this.previewBlockMesh.visible = false;
    }

    this.refreshBlockHighlights();
    this.emitSnapshot();
  }

  public playRemoteSfx(sfx: SfxEventType, intensity = 0.5): void {
    switch (sfx) {
      case 'impact':
        woodAudio.playWoodImpact(intensity);
        break;
      case 'slide':
        woodAudio.playWoodSlide(intensity * 3.5);
        break;
      case 'extract':
        woodAudio.playExtractChime();
        if (this.hapticsEnabled && this.isMyOnlineTurn && 'vibrate' in navigator) {
          navigator.vibrate(18);
        }
        break;
      case 'place':
        woodAudio.playPlaceSuccess();
        break;
      case 'collapse':
        woodAudio.playCollapseCue();
        break;
      case 'locked':
        woodAudio.playWoodImpact(0.18, -80);
        break;
    }
  }

  public clearBlockSelection(): void {
    if (this.onlineMode) {
      if (this.isMyOnlineTurn) {
        this.callbacks.onOnlineInput?.({ type: 'game:select_block', blockId: null });
      }
      return;
    }
    this.selectedBlock = null;
    this.manualSlideDir = 0;
    this.refreshBlockHighlights();
    this.emitSnapshot();
  }

  /**
   * One-handed bottom dock slide control:
   * dir = 1 pulls selected block toward the camera; dir = -1 pushes away from camera; 0 stops.
   */
  public setManualSlide(dir: -1 | 0 | 1): void {
    if (this.onlineMode) {
      if (!this.isMyOnlineTurn) return;
      this.callbacks.onOnlineInput?.({
        type: 'game:manual_slide',
        dir,
        camX: this.camera.position.x,
        camZ: this.camera.position.z,
      });
      return;
    }

    if (!this.selectedBlock || (this.phase !== 'inspect' && this.phase !== 'pulling')) {
      this.manualSlideDir = 0;
      return;
    }

    if (dir === 0) {
      if (this.manualSlideDir !== 0 && this.selectedBlock) {
        this.selectedBlock.body.material = this.blockPhysMat;
        this.selectedBlock.body.velocity.scale(0.08, this.selectedBlock.body.velocity);
        this.selectedBlock.body.angularVelocity.set(0, 0, 0);
      }
      this.manualSlideDir = 0;
      if (this.phase === 'pulling' && !this.isDraggingBlock) {
        this.phase = 'inspect';
        this.activeBlock = null;
        this.emitSnapshot();
      }
      return;
    }

    const check = this.isBlockPullable(this.selectedBlock);
    if (!check.ok) return;

    this.manualSlideDir = dir;
    this.activeBlock = this.selectedBlock;
    this.activeBlock.body.material = this.pullingPhysMat;
    this.dragStartY = this.activeBlock.body.position.y;
    this.phase = 'pulling';
    this.wakeAllBlocks();
    this.emitSnapshot();
  }

  public focusCameraZone(zone: CameraFocusZone, immediate = false): void {
    const maxLayer = this.getMaxTowerLayer();
    const towerTopY = COASTER_TOP_Y + (maxLayer + 1) * BLOCK_H;

    let targetY = towerTopY * 0.5;
    if (zone === 'low') targetY = Math.max(1.8, towerTopY * 0.22);
    else if (zone === 'mid') targetY = Math.max(3.6, towerTopY * 0.52);
    else if (zone === 'top') targetY = Math.max(4.5, towerTopY - 0.6);

    this.desiredCamTargetY = targetY;
    if (immediate) {
      this.controls.target.set(0, targetY, 0);
      this.camera.position.set(7.4, targetY + 3.4, 8.6);
      this.cameraTransitionActive = false;
    } else {
      const dist = zone === 'top' ? 9.4 : 10.6;
      const angle = Math.atan2(this.camera.position.x, this.camera.position.z);
      this.desiredCamPos.set(
        Math.sin(angle) * dist,
        targetY + (zone === 'top' ? 3.8 : 2.5),
        Math.cos(angle) * dist
      );
      this.cameraTransitionActive = true;
    }
  }

  public resetCameraView(): void {
    const maxLayer = this.getMaxTowerLayer();
    const towerTopY = COASTER_TOP_Y + (maxLayer + 1) * BLOCK_H;
    this.desiredCamTargetY = towerTopY * 0.52;
    this.desiredCamPos.set(7.4, this.desiredCamTargetY + 3.2, 8.6);
    this.cameraTransitionActive = true;
  }

  public selectPlacementSlot(slot: 0 | 1 | 2): void {
    if (this.onlineMode) {
      if (!this.isMyOnlineTurn || this.phase !== 'placing') return;
      this.callbacks.onOnlineInput?.({ type: 'game:select_slot', slot });
      return;
    }
    if (this.phase !== 'placing') return;
    if (!this.availableSlots.includes(slot)) return;
    this.selectedSlot = slot;
    this.updateGhostSlotVisuals();
    this.emitSnapshot();
  }

  public confirmPlaceBlock(): void {
    if (this.onlineMode) {
      if (!this.isMyOnlineTurn || this.phase !== 'placing') return;
      this.callbacks.onOnlineInput?.({ type: 'game:confirm_place' });
      return;
    }
    if (this.phase !== 'placing' || !this.activeBlock) return;
    if (!this.availableSlots.includes(this.selectedSlot)) return;

    const block = this.activeBlock;
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
    block.mesh.visible = true;
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
    this.hideGhostSlots();
    this.previewBlockMesh.visible = false;
    this.activeBlock = null;
    this.selectedBlock = null;
    this.hoveredBlock = null;
    this.refreshBlockHighlights();

    this.phase = 'settling';
    this.settleTimer = 1.15;
    this.controls.enabled = true;
    woodAudio.playWoodImpact(0.42);
    this.emitSnapshot();
  }

  private getMaxTowerLayer(): number {
    let maxL = 0;
    for (const b of this.blocks) {
      if (b === this.activeBlock && this.phase === 'placing') continue;
      if (b.layer > maxL) maxL = b.layer;
    }
    return maxL;
  }

  private getTowerBlocksInLayer(layer: number): BlockEntity[] {
    return this.blocks.filter(
      (b) => !(b === this.activeBlock && this.phase === 'placing') && b.layer === layer
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

  private isBlockPullable(block: BlockEntity): { ok: boolean; reason?: string } {
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

  private evaluateBlockStability(block: BlockEntity): StabilityInfo {
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
      if (b !== this.activeBlock && b.layer > block.layer) {
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
    for (const b of this.blocks) {
      b.body.wakeUp();
    }
  }

  private wakeNearbyLayers(minLayer: number): void {
    for (const b of this.blocks) {
      if (b.layer >= minLayer) {
        b.body.wakeUp();
      }
    }
  }

  private refreshBlockHighlights(): void {
    const focusBlock = this.activeBlock || this.selectedBlock || this.hoveredBlock;

    for (const b of this.blocks) {
      if (b === this.activeBlock || b === this.selectedBlock || b === this.hoveredBlock) {
        if (this.guideEnabled) {
          const info = this.evaluateBlockStability(b);
          if (info.level === 'safe') {
            b.material.emissive.setHex(0x1b7a43);
            b.material.emissiveIntensity =
              b === this.activeBlock || b === this.selectedBlock ? 0.38 : 0.22;
          } else if (info.level === 'caution') {
            b.material.emissive.setHex(0xd97706);
            b.material.emissiveIntensity =
              b === this.activeBlock || b === this.selectedBlock ? 0.4 : 0.24;
          } else if (info.level === 'risky') {
            b.material.emissive.setHex(0xc82828);
            b.material.emissiveIntensity =
              b === this.activeBlock || b === this.selectedBlock ? 0.42 : 0.26;
          } else {
            b.material.emissive.setHex(0x6b5d52);
            b.material.emissiveIntensity = 0.18;
          }
        } else {
          b.material.emissive.setHex(0xc2592b);
          b.material.emissiveIntensity =
            b === this.activeBlock || b === this.selectedBlock ? 0.3 : 0.14;
        }
      } else {
        b.material.emissive.setHex(0x000000);
        b.material.emissiveIntensity = 0;
      }
    }

    // Update 3D directional arrows on pullable focus block
    if (
      focusBlock &&
      (this.phase === 'inspect' || this.phase === 'pulling') &&
      this.isBlockPullable(focusBlock).ok
    ) {
      this.pullArrowGroup.visible = true;
      this.pullArrowGroup.position.copy(focusBlock.mesh.position);
      this.pullArrowGroup.quaternion.copy(focusBlock.mesh.quaternion);
    } else {
      this.pullArrowGroup.visible = false;
    }
  }

  private computeBlockAxes(block: BlockEntity): void {
    _longDir.set(0, 0, 1).applyQuaternion(block.mesh.quaternion);
    _longDir.y = 0;
    if (_longDir.lengthSq() < 0.001) _longDir.set(0, 0, 1);
    _longDir.normalize();
    this.dragLongAxis.copy(_longDir);

    _latDir.set(-_longDir.z, 0, _longDir.x).normalize();
    this.dragLatAxis.copy(_latDir);
  }

  private enterPlacingPhase(block: BlockEntity): void {
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;
    this.pullArrowGroup.visible = false;
    this.phase = 'placing';
    this.extractedCount += 1;
    woodAudio.playExtractChime();
    if (this.hapticsEnabled && 'vibrate' in navigator) {
      navigator.vibrate(18);
    }

    block.body.material = this.blockPhysMat;
    block.body.type = CANNON.Body.KINEMATIC;
    block.body.collisionResponse = false;
    block.body.velocity.set(0, 0, 0);
    block.body.angularVelocity.set(0, 0, 0);
    block.body.position.set(0, -25, 0);
    block.mesh.visible = false;
    this.selectedBlock = null;

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

    this.updateGhostSlotVisuals();
    this.focusCameraZone('top', false);
    this.controls.enabled = true;
    this.emitSnapshot();
  }

  private hideGhostSlots(): void {
    for (const g of this.ghostSlots) {
      g.mesh.visible = false;
    }
  }

  private updateGhostSlotVisuals(): void {
    const targetLayer = this.targetPlaceLayer;
    const isOdd = targetLayer % 2 === 1;
    const y = COASTER_TOP_Y + BLOCK_H / 2 + targetLayer * BLOCK_H;
    const center = this.getTopLayerCenterXZ(targetLayer - 1);

    for (const g of this.ghostSlots) {
      const avail = this.availableSlots.includes(g.slot);
      g.available = avail;
      g.mesh.visible = avail;
      if (!avail) continue;

      const offset = (g.slot - 1) * (BLOCK_W + LAYER_GAP);
      const x = isOdd ? center.x : center.x + offset;
      const z = isOdd ? center.z + offset : center.z;
      g.mesh.position.set(x, y, z);
      g.mesh.rotation.set(0, isOdd ? Math.PI / 2 : 0, 0);

      const isSelected = g.slot === this.selectedSlot;
      g.material.color.set(isSelected ? '#C2592B' : '#7C6D5E');
      g.material.opacity = isSelected ? 0.42 : 0.16;

      if (isSelected) {
        this.previewBlockMesh.visible = true;
        this.previewBlockMesh.position.set(x, y + 0.56, z);
        this.previewBlockMesh.rotation.set(0, isOdd ? Math.PI / 2 : 0, 0);
      }
    }
  }

  private triggerCollapse(): void {
    if (this.phase === 'collapsing' || this.phase === 'gameover') return;
    this.phase = 'collapsing';
    this.isDraggingBlock = false;
    this.manualSlideDir = 0;
    this.pullArrowGroup.visible = false;
    this.hideGhostSlots();
    this.previewBlockMesh.visible = false;

    if (this.activeBlock) {
      this.activeBlock.body.material = this.blockPhysMat;
      this.activeBlock.body.type = CANNON.Body.DYNAMIC;
      this.activeBlock.body.collisionResponse = true;
      this.activeBlock = null;
    }
    this.selectedBlock = null;

    this.wakeAllBlocks();
    this.timeScale = 0.28;
    this.collapseTimer = 2.6;
    this.controls.enabled = false;
    this.cameraTransitionActive = false;

    woodAudio.playCollapseCue();
    if (this.hapticsEnabled && 'vibrate' in navigator) {
      navigator.vibrate([45, 35, 85]);
    }
    this.emitSnapshot();
  }

  private checkTowerCollapse(): boolean {
    if (this.phase === 'menu' || this.phase === 'collapsing' || this.phase === 'gameover') {
      return false;
    }

    let fallenCount = 0;
    for (const b of this.blocks) {
      if (b === this.activeBlock || b === this.selectedBlock) continue;

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

  private getCurrentValidTowerLayers(): number {
    let maxL = 0;
    for (const b of this.blocks) {
      if (b === this.activeBlock && this.phase === 'placing') continue;
      if (b.layer > maxL) maxL = b.layer;
    }
    return maxL + 1;
  }

  private emitSnapshot(): void {
    const targetBlock = this.activeBlock || this.selectedBlock || this.hoveredBlock;
    const stability = this.onlineMode
      ? this.remoteStability
      : targetBlock
        ? this.evaluateBlockStability(targetBlock)
        : null;
    const maxL = this.getMaxTowerLayer();
    const topLayerCount = this.getTowerBlocksInLayer(maxL).length;

    this.callbacks.onSnapshot({
      phase: this.phase,
      currentLayers: this.getCurrentValidTowerLayers(),
      extractedCount: this.extractedCount,
      selectedSlot: this.selectedSlot,
      availableSlots: [...this.availableSlots],
      selectedBlockId:
        this.selectedBlock && this.isBlockPullable(this.selectedBlock).ok
          ? this.selectedBlock.id
          : null,
      stability,
      lockedNotice: this.lockedNotice,
      isPullableHover: Boolean(targetBlock && stability?.level !== 'locked'),
      topLayerCount,
    });
  }

  private updatePointerNdc(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    woodAudio.unlock();
    if (this.phase === 'menu' || this.phase === 'collapsing' || this.phase === 'gameover') {
      return;
    }
    if (this.onlineMode && !this.isMyOnlineTurn) {
      // Spectators always retain free camera rotation
      return;
    }

    this.pointerDownClientX = e.clientX;
    this.pointerDownClientY = e.clientY;
    this.pointerDownTime = performance.now();

    this.updatePointerNdc(e.clientX, e.clientY);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    if (this.phase === 'placing') {
      const availMeshes = this.ghostSlots.filter((g) => g.available).map((g) => g.mesh);
      const hits = this.raycaster.intersectObjects(availMeshes, false);
      if (hits.length > 0) {
        const slot = hits[0].object.userData.ghostSlot as 0 | 1 | 2;
        const now = performance.now();
        if (this.lastTapGhostSlot === slot && now - this.lastTapTime < 420) {
          this.selectPlacementSlot(slot);
          this.confirmPlaceBlock();
          this.lastTapGhostSlot = null;
          return;
        }
        this.lastTapGhostSlot = slot;
        this.lastTapTime = now;
        this.selectPlacementSlot(slot);
      }
      return;
    }

    if (this.phase !== 'inspect') return;

    const blockMeshes = this.blocks.map((b) => b.mesh);
    const hits = this.raycaster.intersectObjects(blockMeshes, false);
    if (hits.length === 0) {
      this.hoveredBlock = null;
      this.refreshBlockHighlights();
      this.emitSnapshot();
      return;
    }

    const hitId = hits[0].object.userData.blockId as number;
    const block = this.blocks.find((b) => b.id === hitId);
    if (!block) return;

    const pullCheck = this.isBlockPullable(block);
    if (!pullCheck.ok) {
      if (this.onlineMode) {
        this.callbacks.onOnlineInput?.({
          type: 'game:drag_start',
          blockId: block.id,
          targetX: block.mesh.position.x,
          targetZ: block.mesh.position.z,
        });
        return;
      }
      this.lockedNotice = pullCheck.reason || 'このブロックは抜けません';
      this.lockedNoticeTimer = 2.0;
      this.hoveredBlock = block;
      this.refreshBlockHighlights();
      woodAudio.playWoodImpact(0.18, -80);
      this.emitSnapshot();
      return;
    }

    if (this.onlineMode) {
      this.dragStartY = block.mesh.position.y;
      this.dragPlane.set(_upAxis, -this.dragStartY);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, _rayHit)) {
        this.isDraggingBlock = true;
        this.controls.enabled = false;
        this.cameraTransitionActive = false;
        this.lastOnlineDragSentAt = performance.now();
        this.callbacks.onOnlineInput?.({
          type: 'game:drag_start',
          blockId: block.id,
          targetX: _rayHit.x,
          targetZ: _rayHit.z,
        });
      }
      return;
    }

    // Begin axis-assisted pull drag
    this.lockedNotice = null;
    this.activeBlock = block;
    this.selectedBlock = block;
    this.hoveredBlock = block;
    this.isDraggingBlock = true;
    this.manualSlideDir = 0;
    this.phase = 'pulling';
    this.controls.enabled = false;
    this.cameraTransitionActive = false;

    block.body.material = this.pullingPhysMat;
    this.wakeAllBlocks();
    this.computeBlockAxes(block);

    this.dragStartY = block.body.position.y;
    this.dragPlane.set(_upAxis, -this.dragStartY);
    this.dragStartBodyPos.set(
      block.body.position.x,
      block.body.position.y,
      block.body.position.z
    );

    if (this.raycaster.ray.intersectPlane(this.dragPlane, _rayHit)) {
      this.dragStartWorld.copy(_rayHit);
      this.dragCurrentWorld.copy(_rayHit);
    }

    this.refreshBlockHighlights();
    this.emitSnapshot();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.onlineMode) {
      if (this.isMyOnlineTurn && this.isDraggingBlock) {
        const now = performance.now();
        if (now - this.lastOnlineDragSentAt < 32) return;
        this.lastOnlineDragSentAt = now;
        this.updatePointerNdc(e.clientX, e.clientY);
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        if (this.raycaster.ray.intersectPlane(this.dragPlane, _rayHit)) {
          this.callbacks.onOnlineInput?.({
            type: 'game:drag_move',
            targetX: _rayHit.x,
            targetZ: _rayHit.z,
          });
        }
      }
      return;
    }

    if (this.phase === 'pulling' && this.isDraggingBlock && this.activeBlock) {
      this.updatePointerNdc(e.clientX, e.clientY);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, _rayHit)) {
        this.dragCurrentWorld.copy(_rayHit);
      }
      return;
    }

    if (e.pointerType === 'mouse' && this.phase === 'inspect') {
      this.updatePointerNdc(e.clientX, e.clientY);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects(
        this.blocks.map((b) => b.mesh),
        false
      );
      const nextHover =
        hits.length > 0
          ? this.blocks.find((b) => b.id === hits[0].object.userData.blockId) || null
          : null;

      if (nextHover !== this.hoveredBlock) {
        this.hoveredBlock = nextHover;
        this.renderer.domElement.style.cursor = nextHover ? 'grab' : 'default';
        this.refreshBlockHighlights();
        this.emitSnapshot();
      }
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.onlineMode) {
      if (!this.isMyOnlineTurn) return;
      const movedPx = Math.hypot(
        e.clientX - this.pointerDownClientX,
        e.clientY - this.pointerDownClientY
      );
      const elapsed = performance.now() - this.pointerDownTime;

      if (this.isDraggingBlock) {
        this.isDraggingBlock = false;
        this.controls.enabled = true;
        this.callbacks.onOnlineInput?.({ type: 'game:drag_end' });
        return;
      }

      if (this.phase === 'inspect' && movedPx < 8 && elapsed < 260 && this.selectedBlock) {
        this.updatePointerNdc(e.clientX, e.clientY);
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        const hits = this.raycaster.intersectObjects(
          this.blocks.map((b) => b.mesh),
          false
        );
        if (hits.length === 0) {
          this.callbacks.onOnlineInput?.({ type: 'game:select_block', blockId: null });
        }
      }
      return;
    }

    const movedPx = Math.hypot(
      e.clientX - this.pointerDownClientX,
      e.clientY - this.pointerDownClientY
    );
    const elapsed = performance.now() - this.pointerDownTime;

    // Clean short tap on background clears selectedBlock
    if (
      this.phase === 'inspect' &&
      !this.isDraggingBlock &&
      movedPx < 8 &&
      elapsed < 260 &&
      this.selectedBlock
    ) {
      this.updatePointerNdc(e.clientX, e.clientY);
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects(
        this.blocks.map((b) => b.mesh),
        false
      );
      if (hits.length === 0) {
        this.selectedBlock = null;
        this.refreshBlockHighlights();
        this.emitSnapshot();
      }
    }

    if (this.phase === 'pulling' && this.isDraggingBlock) {
      this.isDraggingBlock = false;
      if (this.activeBlock) {
        this.activeBlock.body.material = this.blockPhysMat;
        this.activeBlock.body.velocity.scale(0.08, this.activeBlock.body.velocity);
        this.activeBlock.body.angularVelocity.set(0, 0, 0);
      }
      // Keep selectedBlock active so user can use thumb slide buttons or drag again
      this.activeBlock = null;
      this.phase = 'inspect';
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = 'default';
      this.refreshBlockHighlights();
      this.emitSnapshot();
    }
  };

  private handleResize = (): void => {
    if (this.disposed) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private bindEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
    window.addEventListener('resize', this.handleResize);
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || !gl.fenceSync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private startLoop(): void {
    this.clock.start();
    const tick = () => {
      if (this.disposed) return;
      const rawDelta = Math.min(this.clock.getDelta(), 0.05);

      this.stepSimulation(rawDelta);
      this.renderer.render(this.scene, this.camera);

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    if (this.isSoftwareGl) {
      this.frameId = window.setTimeout(tick, 16);
    } else {
      this.frameId = requestAnimationFrame(tick);
    }
  }

  private stepSimulation(rawDelta: number): void {
    if (this.lockedNotice && this.lockedNoticeTimer > 0) {
      this.lockedNoticeTimer -= rawDelta;
      if (this.lockedNoticeTimer <= 0) {
        this.lockedNotice = null;
        this.emitSnapshot();
      }
    }

    // 1. Axis-constrained 3D drag OR manual one-handed thumb slide (offline/local physics only)
    if (!this.onlineMode) {
      if (this.phase === 'pulling' && this.activeBlock) {
        const b = this.activeBlock;
        b.body.wakeUp();

        if (this.isDraggingBlock) {
          // Project pointer delta onto the block's longitudinal slot axis (prevents sideways smashing)
          _vec3B.copy(this.dragCurrentWorld).sub(this.dragStartWorld);
          const longDist = _vec3B.dot(this.dragLongAxis);
          const latDist = _vec3B.dot(this.dragLatAxis) * 0.08; // tiny organic give, mostly locked to channel

          const targetX =
            this.dragStartBodyPos.x +
            this.dragLongAxis.x * longDist +
            this.dragLatAxis.x * latDist;
          const targetZ =
            this.dragStartBodyPos.z +
            this.dragLongAxis.z * longDist +
            this.dragLatAxis.z * latDist;

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

          if (speed > 0.35) {
            woodAudio.playWoodSlide(speed);
          }
        } else if (this.manualSlideDir !== 0) {
          // Slide smoothly along longitudinal axis relative to camera direction
          this.computeBlockAxes(b);
          _camDir.set(
            b.body.position.x - this.camera.position.x,
            0,
            b.body.position.z - this.camera.position.z
          );
          // Pick sign of dragLongAxis pointing TOWARD the camera for "pull" (dir = +1)
          const dotCam = this.dragLongAxis.dot(_camDir);
          const towardCamSign = dotCam > 0 ? -1 : 1;
          const slideSign = towardCamSign * this.manualSlideDir;
          const slideSpeed = 2.4;
          const dy = Math.max(this.dragStartY, b.body.position.y) - b.body.position.y;

          b.body.velocity.set(
            this.dragLongAxis.x * slideSign * slideSpeed,
            Math.max(-0.1, dy * 6),
            this.dragLongAxis.z * slideSign * slideSpeed
          );
          b.body.angularVelocity.set(0, 0, 0);
          woodAudio.playWoodSlide(slideSpeed);
        }

        // Check extraction completion (clears tower cleanly at 90% of block length)
        const center = this.getTopLayerCenterXZ(b.layer);
        const radialDist = Math.hypot(b.body.position.x - center.x, b.body.position.z - center.z);
        if (radialDist > BLOCK_L * 0.9) {
          this.enterPlacingPhase(b);
        }
      }

      // If a selected block was pulled >70% out and dropped clear after finger release, treat as extracted
      if (this.phase === 'inspect' && this.selectedBlock) {
        const sb = this.selectedBlock;
        const center = this.getTopLayerCenterXZ(sb.layer);
        const radialDist = Math.hypot(sb.body.position.x - center.x, sb.body.position.z - center.z);
        const expectedY = COASTER_TOP_Y + BLOCK_H / 2 + sb.layer * BLOCK_H;
        if (radialDist > BLOCK_L * 0.7 && sb.body.position.y < expectedY - BLOCK_H * 0.32) {
          this.activeBlock = sb;
          this.enterPlacingPhase(sb);
        }
      }
    }

    if (this.onlineMode) {
      // Smooth 60fps interpolation toward server-authoritative transforms
      const alpha = 1 - Math.exp(-26 * rawDelta);
      for (const b of this.blocks) {
        if (!b.mesh.visible) continue;
        b.mesh.position.lerp(b.remotePos, alpha);
        b.mesh.quaternion.slerp(b.remoteQuat, alpha);
      }

      const arrowTarget = this.activeBlock || this.selectedBlock;
      if (this.pullArrowGroup.visible && arrowTarget) {
        this.pullArrowGroup.position.copy(arrowTarget.mesh.position);
        this.pullArrowGroup.quaternion.copy(arrowTarget.mesh.quaternion);
        const pulseOffset = Math.sin(this.clock.elapsedTime * 5.0) * 0.06;
        this.pullArrowForward.position.z = BLOCK_L / 2 + 0.34 + pulseOffset;
        this.pullArrowBackward.position.z = -(BLOCK_L / 2 + 0.34 + pulseOffset);
      }

      if (this.phase === 'placing' && this.previewBlockMesh.visible) {
        const t = this.clock.elapsedTime;
        const baseY = COASTER_TOP_Y + BLOCK_H / 2 + this.targetPlaceLayer * BLOCK_H + 0.56;
        this.previewBlockMesh.position.y = baseY + Math.sin(t * 3.2) * 0.06;
      }

      if (this.phase === 'collapsing') {
        const angle = rawDelta * 0.55;
        _vec3A.copy(this.camera.position).sub(this.controls.target);
        _vec3A.applyAxisAngle(_upAxis, angle);
        const currentDist = _vec3A.length();
        const targetDist = Math.max(currentDist, 12.2);
        const nextDist = THREE.MathUtils.damp(currentDist, targetDist, 2.2, rawDelta);
        _vec3A.normalize().multiplyScalar(nextDist);
        _vec3A.y = THREE.MathUtils.damp(_vec3A.y, 6.2, 2.0, rawDelta);
        this.camera.position.copy(this.controls.target).add(_vec3A);
        this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, 2.4, 2.5, rawDelta);
        this.camera.lookAt(this.controls.target);
        return;
      }
    } else {
      // Fine fixed-timestep sub-stepping for high-precision collision detection
      const scaledDt = rawDelta * this.timeScale;
      this.world.step(1 / 240, scaledDt, 10);

      // Sync Three.js meshes with Cannon bodies
      for (const b of this.blocks) {
        if (b === this.activeBlock && this.phase === 'placing') continue;
        b.mesh.position.set(b.body.position.x, b.body.position.y, b.body.position.z);
        b.mesh.quaternion.set(
          b.body.quaternion.x,
          b.body.quaternion.y,
          b.body.quaternion.z,
          b.body.quaternion.w
        );
      }

      // Keep 3D direction arrows attached cleanly to the focused block
      const arrowTarget = this.activeBlock || this.selectedBlock || this.hoveredBlock;
      if (this.pullArrowGroup.visible && arrowTarget) {
        this.pullArrowGroup.position.copy(arrowTarget.mesh.position);
        this.pullArrowGroup.quaternion.copy(arrowTarget.mesh.quaternion);
        const pulseOffset = Math.sin(this.clock.elapsedTime * 5.0) * 0.06;
        this.pullArrowForward.position.z = BLOCK_L / 2 + 0.34 + pulseOffset;
        this.pullArrowBackward.position.z = -(BLOCK_L / 2 + 0.34 + pulseOffset);
      }

      // Gentle floating bob for preview block during placing
      if (this.phase === 'placing' && this.previewBlockMesh.visible) {
        const t = this.clock.elapsedTime;
        const baseY = COASTER_TOP_Y + BLOCK_H / 2 + this.targetPlaceLayer * BLOCK_H + 0.56;
        this.previewBlockMesh.position.y = baseY + Math.sin(t * 3.2) * 0.06;
      }

      // Monitor collapse during active gameplay
      if (
        (this.phase === 'inspect' ||
          this.phase === 'pulling' ||
          this.phase === 'placing' ||
          this.phase === 'settling') &&
        this.checkTowerCollapse()
      ) {
        this.triggerCollapse();
      }

      // Settling countdown after block placement
      if (this.phase === 'settling') {
        this.settleTimer -= rawDelta;
        if (this.settleTimer <= 0) {
          this.phase = 'inspect';
          const layers = this.getCurrentValidTowerLayers();
          woodAudio.playPlaceSuccess();
          this.emitSnapshot();
          this.callbacks.onTurnComplete(layers, this.extractedCount);
        }
      }

      // Slow-motion collapse camera orbit choreography
      if (this.phase === 'collapsing') {
        this.collapseTimer -= rawDelta;
        const angle = rawDelta * 0.55;
        _vec3A.copy(this.camera.position).sub(this.controls.target);
        _vec3A.applyAxisAngle(_upAxis, angle);
        const currentDist = _vec3A.length();
        const targetDist = Math.max(currentDist, 12.2);
        const nextDist = THREE.MathUtils.damp(currentDist, targetDist, 2.2, rawDelta);
        _vec3A.normalize().multiplyScalar(nextDist);
        _vec3A.y = THREE.MathUtils.damp(_vec3A.y, 6.2, 2.0, rawDelta);
        this.camera.position.copy(this.controls.target).add(_vec3A);
        this.controls.target.y = THREE.MathUtils.damp(this.controls.target.y, 2.4, 2.5, rawDelta);
        this.camera.lookAt(this.controls.target);

        if (this.collapseTimer <= 0) {
          this.timeScale = 1.0;
          this.phase = 'gameover';
          this.controls.enabled = true;
          this.controls.autoRotate = true;
          this.controls.autoRotateSpeed = 0.5;
          this.emitSnapshot();
          this.callbacks.onCollapse(this.getCurrentValidTowerLayers(), this.extractedCount);
        }
        return;
      }
    }

    if (this.cameraTransitionActive) {
      this.controls.target.y = THREE.MathUtils.damp(
        this.controls.target.y,
        this.desiredCamTargetY,
        6.5,
        rawDelta
      );
      this.camera.position.x = THREE.MathUtils.damp(
        this.camera.position.x,
        this.desiredCamPos.x,
        5.5,
        rawDelta
      );
      this.camera.position.y = THREE.MathUtils.damp(
        this.camera.position.y,
        this.desiredCamPos.y,
        5.5,
        rawDelta
      );
      this.camera.position.z = THREE.MathUtils.damp(
        this.camera.position.z,
        this.desiredCamPos.z,
        5.5,
        rawDelta
      );

      if (
        Math.abs(this.controls.target.y - this.desiredCamTargetY) < 0.03 &&
        this.camera.position.distanceTo(this.desiredCamPos) < 0.08
      ) {
        this.cameraTransitionActive = false;
      }
      this.controls.update();
    } else {
      this.controls.update();
    }

    void _vec3C;
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    window.removeEventListener('resize', this.handleResize);

    for (const b of this.blocks) {
      b.material.dispose();
    }
    for (const g of this.ghostSlots) {
      g.material.dispose();
    }
    (this.previewBlockMesh.material as THREE.Material).dispose();
    this.pullArrowForward.geometry.dispose();
    (this.pullArrowForward.material as THREE.Material).dispose();
    this.blockGeometry.dispose();
    this.ghostGeometry.dispose();
    this.blockMaterialsPool.dispose();
    this.studioRig.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (dom.parentElement) {
      dom.parentElement.removeChild(dom);
    }
  }
}
