import * as THREE from 'three';

const vertexShader = `
varying vec2 vUv;
varying vec3 vPos;

void main() {
    vUv = uv;
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uFoamColor;

varying vec2 vUv;
varying vec3 vPos;

// Simplex noise function or simple pseudo-random
float rand(vec2 co){
    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}

// 2D Noise
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(rand(i + vec2(0.0,0.0)), rand(i + vec2(1.0,0.0)), u.x),
               mix(rand(i + vec2(0.0,1.0)), rand(i + vec2(1.0,1.0)), u.x), u.y);
}

void main() {
    // Flowing water effect
    // We want the water to flow along Y (since we are in local space of plane, rotated later?)
    // Actually our terrain river is along world Z mostly, but meandering.
    // Let's just do a generic noise flow.
    
    vec2 flowDir = vec2(0.0, 1.0);
    vec2 uv = vUv * 10.0;
    
    float n1 = noise(uv + uTime * 0.5);
    float n2 = noise(uv * 2.0 - uTime * 0.2);
    
    float combined = (n1 + n2) * 0.5;
    
    // Color mixing
    vec3 color = mix(uColor, uColor * 1.2, combined);
    
    // Foam (optional edges or high noise values)
    if (combined > 0.8) {
        color = mix(color, uFoamColor, 0.5);
    }

    gl_FragColor = vec4(color, 0.8); // Slight transparency
}
`;

export class Water {
    constructor(scene) {
        this.scene = scene;
        this.init();
    }

    init() {
        this.geometry = new THREE.PlaneGeometry(20, 20, 32, 32);
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: new THREE.Color('#4fc3f7') },
                uFoamColor: { value: new THREE.Color('#ffffff') }
            },
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide
        });

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.rotation.x = -Math.PI / 2;
        this.mesh.position.y = -1.0; // Water level
        this.scene.add(this.mesh);
    }

    update(elapsedTime) {
        this.material.uniforms.uTime.value = elapsedTime;
    }
}
