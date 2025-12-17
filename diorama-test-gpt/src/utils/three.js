import * as THREE from "three";

export function ensureVertexColorAttribute(geometry) {
  if (!geometry?.attributes?.position) return;
  if (geometry.getAttribute?.("color")) return;
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  colors.fill(1);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
