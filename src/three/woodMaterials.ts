import * as THREE from 'three';

export interface WoodPaletteVariant {
  name: string;
  baseHex: string;
  grainHex: string;
  highlightHex: string;
}

const WOOD_VARIANTS: WoodPaletteVariant[] = [
  {
    name: 'Beech',
    baseHex: '#DFB684',
    grainHex: '#B8834E',
    highlightHex: '#ECCCA1',
  },
  {
    name: 'Maple',
    baseHex: '#E8CAA0',
    grainHex: '#C59A67',
    highlightHex: '#F3DFC0',
  },
  {
    name: 'Oak',
    baseHex: '#CE9E69',
    grainHex: '#9C6B3B',
    highlightHex: '#DFB484',
  },
  {
    name: 'Birch',
    baseHex: '#EAD7B7',
    grainHex: '#C8AE85',
    highlightHex: '#F5E7CE',
  },
];

function createWoodCanvasTexture(
  variant: WoodPaletteVariant,
  seed: number,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Base wood fill
  ctx.fillStyle = variant.baseHex;
  ctx.fillRect(0, 0, width, height);

  // Subtle plank longitudinal gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, variant.highlightHex);
  grad.addColorStop(0.5, variant.baseHex);
  grad.addColorStop(1, variant.highlightHex);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Organic wavy wood grain lines
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = variant.grainHex;
  const lineCount = 46;
  for (let i = 0; i < lineCount; i++) {
    const baseY = (i / lineCount) * height;
    const freq = 0.012 + ((i + seed) % 5) * 0.003;
    const amp = 2.5 + ((i * 3 + seed) % 6);
    const phase = (seed * 1.7 + i * 0.63) % (Math.PI * 2);

    ctx.lineWidth = 0.7 + ((i + seed) % 3) * 0.55;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 8) {
      const y = baseY + Math.sin(x * freq + phase) * amp + Math.cos(x * freq * 0.45) * 1.5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Fine wood pores
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = variant.grainHex;
  for (let i = 0; i < 180; i++) {
    const px = ((i * 97 + seed * 53) % width);
    const py = ((i * 61 + seed * 31) % height);
    const len = 8 + ((i * 13) % 24);
    ctx.fillRect(px, py, len, 1);
  }

  // Subtle natural knot ring on some variants
  if (seed % 2 === 0) {
    const kx = 120 + ((seed * 113) % 260);
    const ky = 70 + ((seed * 79) % 116);
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = variant.grainHex;
    for (let r = 4; r <= 18; r += 4) {
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(kx, ky, r * 2.4, r * 0.85, 0.08, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

function createWoodRoughnessTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#B8B8B8'; // ~0.72 base roughness
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 42; i++) {
    const y = (i / 42) * size;
    ctx.strokeStyle = i % 2 === 0 ? '#A2A2A2' : '#CCCCCC';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + Math.sin(i) * 3);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createBlockMaterialPool(renderer: THREE.WebGLRenderer): {
  materials: THREE.MeshStandardMaterial[];
  dispose: () => void;
} {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const roughnessMap = createWoodRoughnessTexture(maxAniso);
  const textures: THREE.Texture[] = [roughnessMap];

  const materials = WOOD_VARIANTS.map((variant, idx) => {
    const map = createWoodCanvasTexture(variant, idx + 1, maxAniso);
    textures.push(map);
    return new THREE.MeshStandardMaterial({
      map,
      roughnessMap,
      roughness: 0.68,
      metalness: 0.02,
      envMapIntensity: 0.65,
    });
  });

  return {
    materials,
    dispose: () => {
      textures.forEach((t) => t.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

export function createTableWoodTexture(maxAnisotropy: number): THREE.CanvasTexture {
  return createWoodCanvasTexture(
    {
      name: 'Walnut',
      baseHex: '#9A724F',
      grainHex: '#6F4E32',
      highlightHex: '#AE845E',
    },
    7,
    maxAnisotropy
  );
}

export function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(42, 30, 20, 0.55)');
  grad.addColorStop(0.55, 'rgba(42, 30, 20, 0.22)');
  grad.addColorStop(1, 'rgba(42, 30, 20, 0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
