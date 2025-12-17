import * as THREE from 'three';

export class Clouds {
    constructor(scene) {
        this.scene = scene;
        this.clouds = [];
        this.uniforms = {
            time: { value: 0 }
        };
    }

    init() {
        // Create cloud clumps
        const cloudCount = 15;
        const particlesPerCloud = 25;
        const totalParticles = cloudCount * particlesPerCloud;

        const geometry = new THREE.SphereGeometry(1, 7, 7);
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9,
            roughness: 0.9,
            metalness: 0.1,
            flatShading: true
        });

        this.mesh = new THREE.InstancedMesh(geometry, material, totalParticles);
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        // Note: Transparent shadow casting works if using customDepthMaterial, 
        // but default standard material might just cast opaque shadows which is fine for clouds.

        const dummy = new THREE.Object3D();
        let index = 0;

        for (let i = 0; i < cloudCount; i++) {
            // Distribute clouds over the area
            const cloudX = (Math.random() - 0.5) * 200;
            const cloudY = 40 + Math.random() * 15;
            const cloudZ = (Math.random() - 0.5) * 200;

            for (let j = 0; j < particlesPerCloud; j++) {
                dummy.position.set(
                    cloudX + (Math.random() - 0.5) * 12,
                    cloudY + (Math.random() - 0.5) * 6,
                    cloudZ + (Math.random() - 0.5) * 10
                );

                const scale = 3 + Math.random() * 4;
                dummy.scale.set(scale, scale * 0.6, scale); // Flattened bottom slightly
                dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

                dummy.updateMatrix();
                this.mesh.setMatrixAt(index++, dummy.matrix);
            }
        }

        this.mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(this.mesh);

        // Custom shader for wind movement
        material.onBeforeCompile = (shader) => {
            shader.uniforms.time = this.uniforms.time;
            shader.vertexShader = `
                uniform float time;
                ${shader.vertexShader}
             `.replace(
                '#include <begin_vertex>',
                `
                #include <begin_vertex>
                // Wind drift
                float speed = 1.0;
                float drift = time * speed;
                
                // Add drift to x position
                // To wrap around, we'd need to reconstruct position from matrix
                // For this simple diorama, gentle floating is enough
                
                transformed.x += sin(time * 0.05 + instanceMatrix[3][2] * 0.01) * 10.0;
                transformed.z += cos(time * 0.03 + instanceMatrix[3][0] * 0.01) * 5.0;
                `
            );
        };
    }

    update(time, deltaTime) {
        this.uniforms.time.value = time;
    }
}
