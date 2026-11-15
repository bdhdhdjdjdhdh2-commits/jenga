import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createContactShadowTexture, createTableWoodTexture } from './woodMaterials';

export interface StudioRig {
  pedestalGroup: THREE.Group;
  keyLight: THREE.DirectionalLight;
  dispose: () => void;
}

export function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function buildStudioScene(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean
): StudioRig {
  const disposables: { dispose: () => void }[] = [];

  // Warm studio linen backdrop + horizon fog
  const bgColor = new THREE.Color('#F4EFE6');
  scene.background = bgColor;
  scene.fog = new THREE.FogExp2('#F4EFE6', 0.015);

  // Mandatory Studio Environment Reflection (RoomEnvironment)
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  pmremGenerator.dispose();
  disposables.push(envTex);

  // 3-Point Warm/Cool Studio Lighting Rig
  const hemiLight = new THREE.HemisphereLight('#E2ECF5', '#B99F84', 0.85);
  hemiLight.position.set(0, 20, 0);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight('#FFF1DC', 1.65);
  keyLight.position.set(7.5, 14.5, 8.5);
  keyLight.castShadow = !isSoftwareGl;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  keyLight.shadow.camera.near = 2;
  keyLight.shadow.camera.far = 36;
  const d = 8.5;
  keyLight.shadow.camera.left = -d;
  keyLight.shadow.camera.right = d;
  keyLight.shadow.camera.top = d;
  keyLight.shadow.camera.bottom = -d;
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);
  scene.add(keyLight.target);

  const rimLight = new THREE.DirectionalLight('#FFE3C2', 0.6);
  rimLight.position.set(-8, 9, -7);
  scene.add(rimLight);

  // Composite Multi-Part Studio Craft Table Pedestal (Top surface sits strictly at Y = 0)
  const pedestalGroup = new THREE.Group();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const tableTex = createTableWoodTexture(maxAniso);
  tableTex.repeat.set(2, 2);
  disposables.push(tableTex);

  const walnutMat = new THREE.MeshStandardMaterial({
    map: tableTex,
    roughness: 0.56,
    metalness: 0.04,
  });
  const darkBaseMat = new THREE.MeshStandardMaterial({
    color: '#3B312A',
    roughness: 0.82,
    metalness: 0.08,
  });
  const brassMat = new THREE.MeshStandardMaterial({
    color: '#C79B52',
    roughness: 0.24,
    metalness: 0.88,
  });
  const feltMat = new THREE.MeshStandardMaterial({
    color: '#D9CEBC',
    roughness: 0.94,
    metalness: 0.0,
  });
  disposables.push(walnutMat, darkBaseMat, brassMat, feltMat);

  // 1. Wide studio floor horizon plane (receive shadows far out)
  const studioFloorGeo = new THREE.CircleGeometry(42, 48);
  const studioFloorMat = new THREE.MeshStandardMaterial({
    color: '#EAE2D4',
    roughness: 0.92,
    metalness: 0.0,
  });
  const studioFloor = new THREE.Mesh(studioFloorGeo, studioFloorMat);
  studioFloor.rotation.x = -Math.PI / 2;
  studioFloor.position.y = -3.4;
  studioFloor.receiveShadow = true;
  pedestalGroup.add(studioFloor);
  disposables.push(studioFloorGeo, studioFloorMat);

  // 2. Central pedestal column
  const columnGeo = new THREE.CylinderGeometry(2.1, 2.7, 3.1, 32);
  const columnMesh = new THREE.Mesh(columnGeo, darkBaseMat);
  columnMesh.position.y = -1.85;
  columnMesh.receiveShadow = true;
  pedestalGroup.add(columnMesh);
  disposables.push(columnGeo);

  // 3. Lower brass collar accent
  const collarGeo = new THREE.TorusGeometry(2.12, 0.055, 12, 48);
  const collarMesh = new THREE.Mesh(collarGeo, brassMat);
  collarMesh.rotation.x = Math.PI / 2;
  collarMesh.position.y = -0.34;
  pedestalGroup.add(collarMesh);
  disposables.push(collarGeo);

  // 4. Primary walnut tabletop slab (top face exactly at y = 0)
  const tabletopGeo = new THREE.CylinderGeometry(5.6, 5.45, 0.32, 48);
  const tabletopMesh = new THREE.Mesh(tabletopGeo, walnutMat);
  tabletopMesh.position.y = -0.16;
  tabletopMesh.receiveShadow = true;
  pedestalGroup.add(tabletopMesh);
  disposables.push(tabletopGeo);

  // 5. Outer chamfered brass rim around tabletop
  const rimGeo = new THREE.TorusGeometry(5.58, 0.045, 12, 64);
  const rimMesh = new THREE.Mesh(rimGeo, brassMat);
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = -0.02;
  pedestalGroup.add(rimMesh);
  disposables.push(rimGeo);

  // 6. Central linen felt coaster disk (offset +0.02 above tabletop to prevent Z-fighting, blocks spawn on y >= 0.02)
  const coasterGeo = new THREE.CylinderGeometry(2.25, 2.28, 0.02, 48);
  const coasterMesh = new THREE.Mesh(coasterGeo, feltMat);
  coasterMesh.position.y = 0.01;
  coasterMesh.receiveShadow = true;
  pedestalGroup.add(coasterMesh);
  disposables.push(coasterGeo);

  // 7. Inlaid brass alignment ring around tower footprint
  const guideRingGeo = new THREE.RingGeometry(2.26, 2.31, 48);
  const guideRingMesh = new THREE.Mesh(guideRingGeo, brassMat);
  guideRingMesh.rotation.x = -Math.PI / 2;
  guideRingMesh.position.y = 0.022;
  pedestalGroup.add(guideRingMesh);
  disposables.push(guideRingGeo);

  // 8. Soft radial contact shadow directly under the tower base
  const shadowTex = createContactShadowTexture();
  const contactGeo = new THREE.PlaneGeometry(4.4, 4.4);
  const contactMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.45,
  });
  const contactShadow = new THREE.Mesh(contactGeo, contactMat);
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.024;
  pedestalGroup.add(contactShadow);
  disposables.push(shadowTex, contactGeo, contactMat);

  scene.add(pedestalGroup);

  return {
    pedestalGroup,
    keyLight,
    dispose: () => {
      disposables.forEach((d) => d.dispose());
      scene.remove(pedestalGroup);
    },
  };
}
