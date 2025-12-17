import * as THREE from 'three';

export class River {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.uniforms = {
            time: { value: 0 }
        };
    }

    init() {
        // Create geometry along the same path as terrain's river
        // Width 20, Length 200 matches terrain
        const geometry = new THREE.PlaneGeometry(20, 200, 20, 100);
        geometry.rotateX(-Math.PI / 2);

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);

            // Match terrain river curve: riverX = Math.sin(vertex.z * 0.05) * 20;
            // Plane center is at 0,0,0. 
            // We want to offset X by the sine wave.
            const riverX = Math.sin(vertex.z * 0.05) * 20;

            positions.setX(i, vertex.x + riverX);
            positions.setY(i, -2.5); // Water level (slightly below terrain -5 to 0 range)
        }
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            color: 0x44aaff,
            roughness: 0.2,
            metalness: 0.6,
            transparent: true,
            opacity: 0.8,
            onBeforeCompile: (shader) => {
                shader.uniforms.time = this.uniforms.time;
                shader.vertexShader = `
                    varying vec2 vUv;
                    varying vec3 vWorldPosition;
                    ${shader.vertexShader}
                `.replace(
                    '#include <worldpos_vertex>',
                    `
                    #include <worldpos_vertex>
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                    `
                );

                shader.fragmentShader = `
                    uniform float time;
                    varying vec2 vUv;
                    varying vec3 vWorldPosition;
                    ${shader.fragmentShader}
                `.replace(
                    '#include <color_fragment>',
                    `
                    #include <color_fragment>
                    
                    // Simple flow & foam
                    float flowOne = sin(vWorldPosition.z * 0.2 + time) * 0.5 + 0.5;
                    float flowTwo = cos(vWorldPosition.z * 0.15 - time * 0.5) * 0.5 + 0.5;
                    
                    // Edge foam
                    float edgeDist = abs(vUv.x - 0.5) * 2.0; // 0 to 1
                    float foam = smoothstep(0.8, 0.95, edgeDist + sin(vWorldPosition.z * 0.5 + time) * 0.05);
                    
                    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), foam);
                    diffuseColor.rgb += vec3(0.1) * flowOne;
                    `
                );
            }
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.scene.add(this.mesh);
    }

    update(deltaTime) {
        this.uniforms.time.value += deltaTime;
    }
}
