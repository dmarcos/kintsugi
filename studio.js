// Studio lighting, backdrop and materials shared by both pages.
import * as THREE from 'three';
import { mix, bakeGold } from './core.js';

let MAX_ANISO = 1;
export function setAnisotropy(renderer) { MAX_ANISO = renderer.capabilities.getMaxAnisotropy(); }

// Warm charcoal backdrop with a soft pool of light behind the piece. Dithered against banding.
export function makeBackdrop() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(512, 430, 40, 512, 512, 760);
  grd.addColorStop(0, '#3d3833');
  grd.addColorStop(0.45, '#221f1c');
  grd.addColorStop(1, '#0a0909');
  g.fillStyle = grd;
  g.fillRect(0, 0, 1024, 1024);
  const img = g.getImageData(0, 0, 1024, 1024), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Photo-studio light probe: dim room, large softboxes, strip lights, and a hot spot for gold glints.
export function studioEnvironment(renderer) {
  const env = new THREE.Scene();
  const room = new THREE.SphereGeometry(30, 64, 32);
  const colors = [], p = room.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / 30;
    const v = t > 0 ? mix(0.07, 0.11, t) : mix(0.07, 0.03, -t);
    colors.push(v * 1.05, v, v * 0.92);
  }
  room.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  env.add(new THREE.Mesh(room, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
  const panel = (w, h, intensity, hex, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0.6, 0);
    env.add(m);
  };
  panel(5, 3.5, 5.5, 0xfff2e2, -4.5, 5, 4.5);   // key softbox
  panel(1.2, 7, 2.6, 0xe6eeff, 7, 2, -1);         // cool strip, right
  panel(1.2, 7, 1.8, 0xfff4ea, -7, 2, -2.5);      // warm strip, left
  panel(9, 1.3, 4.0, 0xffffff, 0, 4.5, -8);       // rim light behind
  panel(6, 4, 2.4, 0xfff6ec, 2, 3, -7);            // back softbox
  panel(5, 3, 1.6, 0xeef2ff, -4, 1.5, -6);         // back fill, low left
  panel(4, 4, 2.2, 0xffffff, 0, 9, 0);            // overhead
  panel(0.7, 0.7, 14, 0xfff0d6, 3.5, 3.2, 5.5);   // small hot spot
  panel(0.5, 2.4, 12, 0xffffff, -3, 2.2, 6);      // thin vertical glint
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  return tex;
}

export const contactTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();

// ---- materials ----------------------------------------------------------------------

export function dataTexture(arr, w, h, srgb, wrapS = THREE.ClampToEdgeWrapping) {
  const t = new THREE.DataTexture(new Uint8Array(arr.buffer), w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = wrapS;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = MAX_ANISO;
  t.needsUpdate = true;
  return t;
}

export const goldMaps = bakeGold();
export const GOLD_F0 = new THREE.Color().setRGB(1.0, 0.74, 0.32);   // linear F0 of gold, nudged warm

export function makeGoldMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: GOLD_F0,
    metalness: 1,
    roughness: 1,
    map: dataTexture(goldMaps.color, goldMaps.w, goldMaps.h, true, THREE.RepeatWrapping),
    roughnessMap: dataTexture(goldMaps.orm, goldMaps.w, goldMaps.h, false, THREE.RepeatWrapping),
    normalMap: dataTexture(goldMaps.nrm, goldMaps.w, goldMaps.h, false, THREE.RepeatWrapping),
    normalScale: new THREE.Vector2(0.3, 0.3),
    vertexColors: true,
    envMapIntensity: 1.45,
  });
}

export const acrylic = new THREE.MeshPhysicalMaterial({
  color: 0xdfe6e4, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.16, depthWrite: false,
  clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6,
});

// The baked maps as textures; potteryMaterial assembles them, the walkthrough adds them one at a time.
export function potteryTextures(piece, maps) {
  const wrap = piece.tex.uv === 'cyl' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return {
    color: dataTexture(maps.color, maps.w, maps.h, true, wrap),
    orm: dataTexture(maps.orm, maps.w, maps.h, false, wrap),
    normal: dataTexture(maps.nrm, maps.w, maps.h, false, wrap),
    coat: dataTexture(maps.coat, maps.w, maps.h, false, wrap),
  };
}

export function potteryMaterial(piece, maps, tex = potteryTextures(piece, maps)) {
  return new THREE.MeshPhysicalMaterial({
    map: tex.color,
    aoMap: tex.orm, roughnessMap: tex.orm, metalnessMap: tex.orm,
    roughness: 1, metalness: 1,
    normalMap: tex.normal,
    normalScale: new THREE.Vector2(piece.normalScale, piece.normalScale),
    clearcoat: piece.coat.clearcoat,
    clearcoatRoughness: piece.coat.roughness,
    clearcoatMap: tex.coat,
    specularIntensity: 1,
    ior: 1.52,
  });
}

// ---- display stand ------------------------------------------------------------------

const box = new THREE.Box3();

// The reference plate stands upright on a small acrylic easel, as photographed.
// Returns the parts and the final holder pose, so the walkthrough can animate into it.
export function mountOnStand(p, material = acrylic) {
  const a = Math.PI / 2 - 0.22;   // lean back 0.22 rad from vertical
  p.holder.rotation.x = a;
  p.holder.updateMatrixWorld(true);
  box.setFromObject(p.holder);
  const BASE = 0.01;               // acrylic base thickness; the rim rests on it
  p.holder.position.y = -box.min.y + BASE;
  p.holder.updateMatrix();
  const lift = p.holder.position.y, ca = Math.cos(a), sa = Math.sin(a);
  const toSpin = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(p.holder.matrix);
  const parts = [];

  // Front tabs: built in plate space, parallel to the face, clearing the glaze and lip,
  // running down past the rim until they meet the base.
  const pos = p.mesh.geometry.attributes.position, z0 = 0.84;
  let frontZ = -Infinity;
  for (const sx of [-1, 1]) {
    const cx = sx * 0.32;
    let top = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i) - cx) < 0.06 && pos.getZ(i) > z0 - 0.03) top = Math.max(top, pos.getY(i));
    }
    const yc = top + 0.012;
    const zEnd = (lift + yc * ca - BASE - 0.004) / sa;
    const tab = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.01, zEnd - z0), material);
    tab.position.set(cx, yc, (z0 + zEnd) / 2);
    p.holder.add(tab);
    parts.push(tab);
    frontZ = Math.max(frontZ, toSpin(cx, yc, zEnd).z);
  }

  // Back support, parallel to the plate, just behind its foot ring.
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.012, 0.86), material);
  back.position.set(0, -0.012, 0.5);
  p.holder.add(back);
  parts.push(back);

  const zFront = frontZ + 0.05, zBack = zFront - 0.6;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, BASE, zFront - zBack), material);
  base.position.set(0, BASE / 2, (zFront + zBack) / 2);
  p.spin.add(base);
  parts.push(base);
  return { parts, angle: a, lift };
}
