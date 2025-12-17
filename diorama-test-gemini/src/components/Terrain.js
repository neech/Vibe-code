import * as THREE from 'three';

const vertexShader = `
varying vec2 vUv;
varying float vElevation;

void main() {
    vUv = uv;
    vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vElevation = wPos.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
uniform float uSnowAccumulation;
uniform vec3 uGrassColor;
uniform vec3 uDirtColor;
uniform vec3 uSnowColor;

varying vec2 vUv;
varying float vElevation;

// Simple noise function (optional, or use texture)
float rand(vec2 co){
    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}

void main() {
    // Basic color mix
    vec3 baseColor = mix(uDirtColor, uGrassColor, smoothstep(0.0, 0.5, vElevation + 0.5)); // Simple height based blending
    
    // Snow accumulation logic
    // If snow accumulation > 0, mix with white strictly based on Up vector usually, but here just global mix
    // Or use noise to make it patchy at low accumulation
    
    float noise = rand(vUv * 10.0);
    float snowThreshold = 1.0 - uSnowAccumulation;
    
    vec3 finalColor = baseColor;
    if (uSnowAccumulation > 0.0) {
        float snowFactor = smoothstep(snowThreshold - 0.1, snowThreshold + 0.1, noise * 0.5 + 0.5); // noise based transition
        // Or simpler:
        snowFactor = uSnowAccumulation; 
        
        finalColor = mix(baseColor, uSnowColor, snowFactor);
    }

    gl_FragColor = vec4(finalColor, 1.0);
}
`;

// Helper for JS-side smoothstep (GLSL-like)
function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export class Terrain {
    constructor(scene) {
        this.scene = scene;

        this.initGeometry();
        this.initMaterial();
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.receiveShadow = true;
        this.mesh.rotation.x = -Math.PI / 2;
        this.scene.add(this.mesh);
    }

    initGeometry() {
        // Create a plane
        this.geometry = new THREE.PlaneGeometry(20, 20, 64, 64);

        // Displace vertices to create a river channel
        const posAttribute = this.geometry.attributes.position;
        for (let i = 0; i < posAttribute.count; i++) {
            const x = posAttribute.getX(i);
            const y = posAttribute.getY(i); // This is Z in world space before rotation
            const z = posAttribute.getZ(i); // This is Y in world space (height)

            // River channel: Function of X (sin wave)
            // Let's say river flows along Y (Z in world) roughly
            const riverCenter = Math.sin(y * 0.5) * 2.0;
            const dist = Math.abs(x - riverCenter);

            // Channel shape
            let height = 0;
            if (dist < 3.0) {
                // Dig down using smoothstep
                height = -1.5 * smoothstep(3.0, 1.0, dist);
            } else {
                // Hills on syntax
                height = Math.sin(x * 0.5) * 0.5 + Math.cos(y * 0.5) * 0.5;
            }

            posAttribute.setZ(i, height); // Displace Z (which becomes Y up)
        }

        this.geometry.computeVertexNormals();
    }

    initMaterial() {
        this.material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms: {
                uSnowAccumulation: { value: 0.0 },
                uGrassColor: { value: new THREE.Color('#4caf50') },
                uDirtColor: { value: new THREE.Color('#5d4037') },
                uSnowColor: { value: new THREE.Color('#ffffff') }
            }
        });
    }

    update(elapsedTime) {
        // Nothing for now
    }
}
