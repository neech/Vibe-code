import * as THREE from 'three';

export class Weather {
    constructor(scene) {
        this.scene = scene;
        this.snowSystem = null;
        this.snowGeometry = null;
        this.snowMaterial = null;
        this.intensity = 0;
    }

    init() {
        const particleCount = 15000;
        this.snowGeometry = new THREE.BufferGeometry();
        const positions = [];
        const velocities = [];

        for (let i = 0; i < particleCount; i++) {
            positions.push(
                (Math.random() - 0.5) * 200,
                Math.random() * 100,
                (Math.random() - 0.5) * 200
            );
            velocities.push(
                (Math.random() - 0.5) * 0.2,
                -0.1 - Math.random() * 0.3,
                (Math.random() - 0.5) * 0.2
            );
        }

        this.snowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        this.snowGeometry.setAttribute('velocity', new THREE.Float32BufferAttribute(velocities, 3));

        // Simple circle texture
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(16, 16, 16, 0, Math.PI * 2);
        ctx.fill();
        const texture = new THREE.CanvasTexture(canvas);

        this.snowMaterial = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 0.5,
            map: texture,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.snowSystem = new THREE.Points(this.snowGeometry, this.snowMaterial);
        this.scene.add(this.snowSystem);
    }

    update(deltaTime) {
        if (!this.snowSystem || this.intensity <= 0) return;

        const positions = this.snowGeometry.attributes.position.array;
        const velocities = this.snowGeometry.attributes.velocity.array;

        for (let i = 0; i < positions.length; i += 3) {
            positions[i] += velocities[i];
            positions[i + 1] += velocities[i + 1];
            positions[i + 2] += velocities[i + 2];

            if (positions[i + 1] < 0) {
                positions[i + 1] = 100;
                positions[i] = (Math.random() - 0.5) * 200;
                positions[i + 2] = (Math.random() - 0.5) * 200;
            }
        }

        this.snowGeometry.attributes.position.needsUpdate = true;
    }

    setSnowIntensity(intensity) {
        this.intensity = intensity;
        if (this.snowMaterial) {
            this.snowMaterial.opacity = intensity;
        }
    }
}
