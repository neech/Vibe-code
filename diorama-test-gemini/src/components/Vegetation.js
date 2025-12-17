import * as THREE from 'three';

const grassVertexShader = `
varying vec2 vUv;
varying float vGlow;
uniform float uTime;
uniform float uWindStrength;
uniform float uSnowAccumulation;

void main() {
    vUv = uv;
    
    vec3 wPos = (instanceMatrix * vec4(position, 1.0)).xyz;
    
    // Wind effect
    float wind = sin(uTime * 2.0 + wPos.x * 0.5 + wPos.z * 0.5) * uWindStrength;
    
    // Stiffness based on height (uv.y 0 is bottom, 1 is top)
    // Only move top of blade
    vec3 pos = position;
    pos.x += wind * uv.y * uv.y; 
    
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
    
    // Simple logic to pass snow/color info
    vGlow = uSnowAccumulation;
}
`;

const grassFragmentShader = `
varying vec2 vUv;
varying float vGlow;
uniform vec3 uBaseColor;
uniform vec3 uTipColor;

void main() {
    vec3 color = mix(uBaseColor, uTipColor, vUv.y);
    
    // Snow accumulation on grass (turns white)
    color = mix(color, vec3(1.0), vGlow * 0.8 * smoothstep(0.3, 1.0, vUv.y)); // More snow on tips?
    
    if (vGlow > 0.5 && vUv.y > 0.8) {
       // Snow cap
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

// Helper for JS-side smoothstep
function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export class Vegetation {
    constructor(scene, terrainGeometry) {
        this.scene = scene;
        this.terrainGeometry = terrainGeometry; // To place objects on ground

        this.params = {
            windStrength: 0.5
        };

        this.initTrees();
        this.initGrass();
    }

    initTrees() {
        // Simple procedural trees
        // Instance mesh would be better but let's do a Group for now to have different trees
        // Actually InstancedMesh for performance if many trees.

        const treeCount = 10;
        const trunkGeo = new THREE.CylinderGeometry(0.2, 0.4, 2);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037 });

        const leavesGeo = new THREE.ConeGeometry(1.5, 3, 8);
        const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32 });

        this.treesGroup = new THREE.Group();

        for (let i = 0; i < treeCount; i++) {
            const x = (Math.random() - 0.5) * 15;
            const z = (Math.random() - 0.5) * 15;

            // Avoid river (simple check from Terrain logic: center roughly sin(z*0.5)*2)
            // Or just check distance to curve
            const riverCenterY = Math.sin(z * 0.5) * 2.0;
            if (Math.abs(x - riverCenterY) < 3.0) continue; // Skip river

            const tree = new THREE.Group();

            const trunk = new THREE.Mesh(trunkGeo, trunkMat);
            trunk.position.y = 1;
            tree.add(trunk);

            const leaves = new THREE.Mesh(leavesGeo, leavesMat);
            leaves.position.y = 2.5;
            tree.add(leaves);

            tree.position.set(x, 0, z); // Y is checked from terrain normally but flat plane logic for now
            // Get height from terrain if needed, but terrain is displaced via vertex shader?
            // Wait, Terrain was modifying geometry in JS, so I can use raycaster or math.

            // Replicating terrain math:
            const dist = Math.abs(x - riverCenterY);
            let height = 0;
            if (dist < 3.0) {
                height = -1.5 * smoothstep(3.0, 1.0, dist);
            } else {
                height = Math.sin(x * 0.5) * 0.5 + Math.cos(z * 0.5) * 0.5;
            }
            tree.position.y = height;

            this.treesGroup.add(tree);
        }

        this.scene.add(this.treesGroup);
    }

    initGrass() {
        const count = 5000;
        const geometry = new THREE.PlaneGeometry(0.1, 1);
        geometry.translate(0, 0.5, 0); // Pivot at bottom

        const material = new THREE.ShaderMaterial({
            vertexShader: grassVertexShader,
            fragmentShader: grassFragmentShader,
            uniforms: {
                uTime: { value: 0 },
                uWindStrength: { value: 0.5 },
                uSnowAccumulation: { value: 0.0 },
                uBaseColor: { value: new THREE.Color(0x2e7d32) },
                uTipColor: { value: new THREE.Color(0x4caf50) }
            },
            side: THREE.DoubleSide
        });

        this.grassMesh = new THREE.InstancedMesh(geometry, material, count);

        const dummy = new THREE.Object3D();
        let index = 0;

        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * 18;
            const z = (Math.random() - 0.5) * 18;

            // Check river
            const riverCenterY = Math.sin(z * 0.5) * 2.0;
            if (Math.abs(x - riverCenterY) < 2.5) continue; // Skip river

            // Height logic
            const dist = Math.abs(x - riverCenterY);
            let height = 0;
            if (dist < 3.0) {
                height = -1.5 * smoothstep(3.0, 1.0, dist);
            } else {
                height = Math.sin(x * 0.5) * 0.5 + Math.cos(z * 0.5) * 0.5;
            }

            dummy.position.set(x, height, z);
            dummy.scale.setScalar(0.5 + Math.random() * 0.5);
            dummy.rotation.y = Math.random() * Math.PI;
            dummy.updateMatrix();
            this.grassMesh.setMatrixAt(index++, dummy.matrix);
        }

        this.grassMesh.instanceMatrix.needsUpdate = true;
        this.grassMesh.count = index; // Update count based on valid placements
        this.scene.add(this.grassMesh);
    }

    update(elapsedTime) {
        if (this.grassMesh) {
            this.grassMesh.material.uniforms.uTime.value = elapsedTime;
            this.grassMesh.material.uniforms.uWindStrength.value = Math.sin(elapsedTime * 0.5) * 0.5 + 0.5;
        }
    }

    updateSnow(snowLevel) {
        // Update Grass
        if (this.grassMesh) {
            this.grassMesh.material.uniforms.uSnowAccumulation.value = snowLevel;
        }

        // Update Trees (Simple tint)
        if (this.treesGroup) {
            this.treesGroup.children.forEach(tree => {
                // Leaves are the second child (index 1) usually, or find by type
                // But we reused geometry/material so changing material changes all.
                // WE MUST CLONE MATERIAL if we want individual control, or reset standard material.
                // However, looping every frame to set color is bad if it's shared material.
                // Actually the material was created ONCE in initTrees: `const leavesMat = ...`
                // So updating leavesMat.color updates ALL trees.
            });

            // Access the material created in init
            // We didn't save it to 'this'. Let's assume we can access it via children.
            const sampleTree = this.treesGroup.children[0];
            if (sampleTree) {
                const leaves = sampleTree.children[1]; // Cone
                if (leaves && leaves.material) {
                    const baseColor = new THREE.Color(0x2e7d32);
                    const snowColor = new THREE.Color(0xffffff);
                    leaves.material.color.copy(baseColor).lerp(snowColor, snowLevel);
                }
            }
        }
    }
}
