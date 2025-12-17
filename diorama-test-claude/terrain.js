import * as THREE from 'three';

export class Terrain {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.uniforms = {
            snowIntensity: { value: 0 }
        };
    }

    init() {
        const geometry = new THREE.PlaneGeometry(200, 200, 100, 100);
        geometry.rotateX(-Math.PI / 2);

        // Deform terrain
        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);

            // River channel (S-curve along Z axis)
            const riverX = Math.sin(vertex.z * 0.05) * 20;
            const distToRiver = Math.abs(vertex.x - riverX);

            // Riverbed
            let height = 0;
            if (distToRiver < 10) {
                // Smooth transition into river
                const t = distToRiver / 10;
                height = -5 + t * 5;
            } else {
                // Hills
                height = Math.sin(vertex.x * 0.1) * 2 + Math.cos(vertex.z * 0.1) * 2;
                height += Math.random() * 0.5; // Roughness
            }

            // Flatten edges for seamless look or just let it be
            positions.setY(i, height);
        }
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            color: 0x3a5a40,
            roughness: 0.9,
            metalness: 0.1,
            onBeforeCompile: (shader) => {
                shader.uniforms.snowIntensity = this.uniforms.snowIntensity;

                shader.vertexShader = `
                    varying vec3 vWorldNormal;
                    ${shader.vertexShader}
                `.replace(
                    '#include <worldpos_vertex>',
                    `
                    #include <worldpos_vertex>
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    `
                );

                shader.fragmentShader = `
                    uniform float snowIntensity;
                    varying vec3 vWorldNormal;
                    ${shader.fragmentShader}
                `.replace(
                    '#include <dithering_fragment>',
                    `
                    #include <dithering_fragment>
                    float snowMix = smoothstep(0.6, 0.9, vWorldNormal.y) * snowIntensity;
                    gl_FragColor = mix(gl_FragColor, vec4(0.95, 0.95, 1.0, 1.0), snowMix);
                    `
                );
            }
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.receiveShadow = true;
        this.scene.add(this.mesh);
    }

    update(deltaTime) {
        // Uniforms are updated by reference
    }

    setSnowIntensity(value) {
        if (this.uniforms) {
            this.uniforms.snowIntensity.value = value;
        }
    }
}
