import * as THREE from 'three';

export class Grass {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.uniforms = {
            time: { value: 0 }
        };
    }

    init() {
        // Create grass
        const instanceCount = 10000;

        // Blade geometry
        const geometry = new THREE.PlaneGeometry(0.1, 1.0, 1, 4);
        geometry.translate(0, 0.5, 0); // Base at 0

        const material = new THREE.MeshStandardMaterial({
            color: 0x4f7942,
            roughness: 1,
            side: THREE.DoubleSide,
            onBeforeCompile: (shader) => {
                shader.uniforms.time = this.uniforms.time;
                shader.vertexShader = `
                    uniform float time;
                    ${shader.vertexShader}
                `.replace(
                    '#include <begin_vertex>',
                    `
                    #include <begin_vertex>
                    // Simple grass sway
                    float sway = sin(time * 3.0 + instanceMatrix[3][0] * 0.5 + instanceMatrix[3][2] * 0.5) * 0.2;
                    float bend = pow(position.y, 2.0);
                    transformed.x += sway * bend;
                    transformed.z += cos(time * 2.0 + instanceMatrix[3][2]) * 0.1 * bend;
                    `
                );
            }
        });

        this.mesh = new THREE.InstancedMesh(geometry, material, instanceCount);
        this.mesh.receiveShadow = true;
        // Grass casting shadow might be too expensive/noisy, maybe disable castShadow
        this.mesh.castShadow = false;

        const dummy = new THREE.Object3D();
        let count = 0;
        let attempt = 0;

        while (count < instanceCount && attempt < 50000) {
            attempt++;

            const x = (Math.random() - 0.5) * 190;
            const z = (Math.random() - 0.5) * 190;

            // Avoid River
            const riverX = Math.sin(z * 0.05) * 20;
            if (Math.abs(x - riverX) < 11) continue;

            // Height
            const y = Math.sin(x * 0.1) * 2 + Math.cos(z * 0.1) * 2;

            dummy.position.set(x, y, z);

            const scale = 0.5 + Math.random() * 0.5;
            dummy.scale.set(scale, scale, scale);
            dummy.rotation.y = Math.random() * Math.PI;

            dummy.updateMatrix();
            this.mesh.setMatrixAt(count, dummy.matrix);

            // Color variation? 
            // InstancedMesh supports color attribute
            const color = new THREE.Color(0x4f7942);
            color.offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
            this.mesh.setColorAt(count, color);

            count++;
        }

        this.mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(this.mesh);
    }

    update(time, deltaTime) {
        this.uniforms.time.value = time;
    }
}
