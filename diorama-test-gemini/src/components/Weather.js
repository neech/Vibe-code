import * as THREE from 'three';

const snowVertexShader = `
varying vec3 vPos;
uniform float uTime;
uniform float uSpeed;

void main() {
    vPos = position;
    
    vec3 pos = position;
    // Fall down
    float fall = uTime * uSpeed;
    pos.y = 15.0 - mod(pos.y + fall, 15.0); // Loop 0-15
    
    // Wiggle
    pos.x += sin(uTime + pos.y) * 0.2;
    pos.z += cos(uTime + pos.y) * 0.2;
    
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = 4.0 * (10.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const snowFragmentShader = `
uniform vec3 uColor;

void main() {
    // Circle shape
    float strength = distance(gl_PointCoord, vec2(0.5));
    strength = 1.0 - strength;
    strength = pow(strength, 3.0);
    
    gl_FragColor = vec4(uColor, strength);
}
`;

export class Weather {
    constructor(scene, gui) {
        this.scene = scene;
        this.gui = gui;

        this.params = {
            snowEnabled: false,
            snowSpeed: 2.0,
            snowAccumulation: 0.0,
            cloudCover: 0.5
        };

        this.initSnow();
        this.initClouds();
        this.setupGUI();
    }

    initSnow() {
        const geometry = new THREE.BufferGeometry();
        const count = 5000;
        const positions = new Float32Array(count * 3);

        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * 30;
            positions[i * 3 + 1] = Math.random() * 15;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 30;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        this.snowMaterial = new THREE.ShaderMaterial({
            vertexShader: snowVertexShader,
            fragmentShader: snowFragmentShader,
            uniforms: {
                uTime: { value: 0 },
                uSpeed: { value: 2.0 },
                uColor: { value: new THREE.Color(0xffffff) }
            },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.snowPoints = new THREE.Points(geometry, this.snowMaterial);
        this.snowPoints.visible = false;
        this.scene.add(this.snowPoints);
    }

    initClouds() {
        // Simple clouds: Group of translucent spheres or low-poly mesh
        this.cloudsGroup = new THREE.Group();
        this.cloudsGroup.position.y = 12;

        const geo = new THREE.DodecahedronGeometry(1, 0);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            roughness: 0.9
        });

        for (let i = 0; i < 5; i++) {
            const cloud = new THREE.Group();
            // Clump of spheres
            const scale = 1 + Math.random();
            cloud.scale.setScalar(scale);

            for (let j = 0; j < 4; j++) {
                const puff = new THREE.Mesh(geo, mat);
                puff.position.set(
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 1,
                    (Math.random() - 0.5) * 2
                );
                puff.scale.setScalar(0.7 + Math.random() * 0.5);
                cloud.add(puff);
            }

            cloud.position.set(
                (Math.random() - 0.5) * 30,
                0,
                (Math.random() - 0.5) * 30
            );

            // Random movement data
            cloud.userData = {
                speed: 0.2 + Math.random() * 0.5
            };

            this.cloudsGroup.add(cloud);
        }

        this.scene.add(this.cloudsGroup);
    }

    setupGUI() {
        const folder = this.gui.addFolder('Weather');
        folder.add(this.params, 'snowEnabled').onChange(v => this.snowPoints.visible = v);
        folder.add(this.params, 'snowAccumulation', 0, 1);
        folder.add(this.params, 'snowSpeed', 0, 10);
    }

    update(elapsedTime, delta) {
        // Update Snow
        if (this.snowMaterial && this.snowPoints.visible) {
            this.snowMaterial.uniforms.uTime.value = elapsedTime;
            this.snowMaterial.uniforms.uSpeed.value = this.params.snowSpeed;

            // Accumulate snow if enabled
            if (this.params.snowAccumulation < 1.0) {
                this.params.snowAccumulation += delta * 0.05; // Auto accumulate
                if (this.params.snowAccumulation > 1.0) this.params.snowAccumulation = 1.0;
            }
        } else {
            // Melting logic? or just static
            if (this.params.snowAccumulation > 0.0 && !this.params.snowEnabled) {
                this.params.snowAccumulation -= delta * 0.1;
                if (this.params.snowAccumulation < 0.0) this.params.snowAccumulation = 0.0;
            }
        }

        // Update Clouds
        this.cloudsGroup.children.forEach(cloud => {
            cloud.position.x += cloud.userData.speed * delta;
            if (cloud.position.x > 20) cloud.position.x = -20;
        });
    }
}
