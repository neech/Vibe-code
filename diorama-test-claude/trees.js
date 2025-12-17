import * as THREE from 'three';

export class Trees {
    constructor(scene) {
        this.scene = scene;
        this.trees = [];
        this.uniforms = {
            time: { value: 0 }
        };
    }

    init() {
        // Create trees
        const treeCount = 80;

        // Trunks
        const trunkGeo = new THREE.CylinderGeometry(0.2, 0.4, 2, 5);
        trunkGeo.translate(0, 1, 0); // Base at 0
        const trunkMat = new THREE.MeshStandardMaterial({
            color: 0x5a4d41,
            roughness: 1.0
        });
        const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
        trunkMesh.castShadow = true;
        trunkMesh.receiveShadow = true;

        // Leaves (2 layers for better look)
        const leavesGeo = new THREE.ConeGeometry(1.5, 3, 5);
        leavesGeo.translate(0, 3, 0);
        const leavesMat = new THREE.MeshStandardMaterial({
            color: 0x2d5a27,
            roughness: 0.8,
            onBeforeCompile: (shader) => {
                shader.uniforms.time = this.uniforms.time;
                shader.vertexShader = `
                    uniform float time;
                    ${shader.vertexShader}
                `.replace(
                    '#include <begin_vertex>',
                    `
                    #include <begin_vertex>
                    // Wind sway based on height
                    // We assume pivot is roughly at y=0 relative to instance
                    // But leaves are offset by translation.
                    // Local y is 1.5 to 4.5
                    
                    float sway = sin(time * 2.0 + instanceMatrix[3][0] * 0.1) * 0.3; // Base sway
                    float windTurbulence = sin(time * 5.0 + position.y * 2.0) * 0.1;
                    
                    float bend = smoothstep(2.0, 5.0, position.y);
                    
                    transformed.x += (sway + windTurbulence) * bend;
                    `
                );
            }
        });
        const leavesMesh = new THREE.InstancedMesh(leavesGeo, leavesMat, treeCount);
        leavesMesh.castShadow = true;
        leavesMesh.receiveShadow = true;

        const dummy = new THREE.Object3D();
        let count = 0;
        let attempt = 0;

        while (count < treeCount && attempt < 500) {
            attempt++;

            // Random position
            const x = (Math.random() - 0.5) * 180;
            const z = (Math.random() - 0.5) * 180;

            // Avoid River check: riverX = Math.sin(vertex.z * 0.05) * 20;
            // Buffer around river = 12
            const riverX = Math.sin(z * 0.05) * 20;
            if (Math.abs(x - riverX) < 12) continue;

            // Get height from terrain formula logic
            // height = Math.sin(vertex.x * 0.1) * 2 + Math.cos(vertex.z * 0.1) * 2;
            const y = Math.sin(x * 0.1) * 2 + Math.cos(z * 0.1) * 2;

            dummy.position.set(x, y, z);

            const scale = 0.8 + Math.random() * 0.6;
            dummy.scale.set(scale, scale, scale);
            dummy.rotation.y = Math.random() * Math.PI * 2;

            dummy.updateMatrix();
            trunkMesh.setMatrixAt(count, dummy.matrix);
            leavesMesh.setMatrixAt(count, dummy.matrix);

            count++;
        }

        this.scene.add(trunkMesh);
        this.scene.add(leavesMesh);
    }

    update(time, deltaTime) {
        this.uniforms.time.value = time;
    }
}
