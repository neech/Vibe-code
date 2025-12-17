import * as THREE from 'three';

export class TimeOfDay {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.sunLight = null;
        this.ambientLight = null;
        this.time = 12; // 0-24
    }

    init() {
        console.log("Initializing TimeOfDay");

        // Ambient Light
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
        this.scene.add(this.ambientLight);

        // Sun Light
        this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = 500;
        this.sunLight.shadow.camera.left = -100;
        this.sunLight.shadow.camera.right = 100;
        this.sunLight.shadow.camera.top = 100;
        this.sunLight.shadow.camera.bottom = -100;
        this.sunLight.shadow.bias = -0.0005;
        this.scene.add(this.sunLight);

        // Sky Background
        this.scene.background = new THREE.Color(0x87CEEB);
    }

    update(time) {
        this.time = time;

        // Calculate sun position based on time (0-24)
        // Noon (12) is overhead, 6 is sunrise, 18 is sunset
        const angle = (time - 6) / 24 * Math.PI * 2;
        const radius = 100;

        this.sunLight.position.x = Math.cos(angle) * radius;
        this.sunLight.position.y = Math.sin(angle) * radius;
        this.sunLight.position.z = 50; // Slight offset

        // Colors
        const dawnColor = new THREE.Color(0xffaa55);
        const dayColor = new THREE.Color(0x87CEEB);
        const duskColor = new THREE.Color(0xff5566);
        const nightColor = new THREE.Color(0x0a0a20);

        let skyColor = new THREE.Color();
        let sunIntensity = 0;
        let ambientIntensity = 0.2;

        if (time >= 5 && time < 7) {
            // Dawn
            const t = (time - 5) / 2;
            skyColor.lerpColors(nightColor, dawnColor, t);
            sunIntensity = t * 1.5;
            ambientIntensity = 0.2 + t * 0.3;
        } else if (time >= 7 && time < 10) {
            // Morning
            const t = (time - 7) / 3;
            skyColor.lerpColors(dawnColor, dayColor, t);
            sunIntensity = 1.5;
            ambientIntensity = 0.5;
        } else if (time >= 10 && time < 16) {
            // Day
            skyColor.copy(dayColor);
            sunIntensity = 1.5;
            ambientIntensity = 0.5;
        } else if (time >= 16 && time < 19) {
            // Dusk
            const t = (time - 16) / 3;
            skyColor.lerpColors(dayColor, duskColor, t);
            sunIntensity = 1.5 * (1 - t);
            ambientIntensity = 0.5 - t * 0.3;
        } else if (time >= 19 && time < 21) {
            // Evening
            const t = (time - 19) / 2;
            skyColor.lerpColors(duskColor, nightColor, t);
            sunIntensity = 0;
            ambientIntensity = 0.2;
        } else {
            // Night
            skyColor.copy(nightColor);
            sunIntensity = 0;
            ambientIntensity = 0.1;
        }

        this.scene.background = skyColor;
        this.sunLight.intensity = sunIntensity;
        this.ambientLight.intensity = ambientIntensity;

        // Fog match sky
        if (this.scene.fog) {
            this.scene.fog.color.copy(skyColor);
        }
    }
}
