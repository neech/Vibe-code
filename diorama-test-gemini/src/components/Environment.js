import * as THREE from 'three';

export class Environment {
    constructor(scene, gui) {
        this.scene = scene;
        this.gui = gui;

        this.params = {
            timeOfDay: 12, // 0-24
            timeSpeed: 0.1,
            sunColor: '#ffffff',
            groundColor: '#333333',
            skyColorTop: '#87CEEB',
            skyColorBottom: '#ffffff'
        };

        this.initLights();
        this.initSky();
        this.setupGUI();
    }

    initLights() {
        this.sunLight = new THREE.DirectionalLight(this.params.sunColor, 2.0);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.1;
        this.sunLight.shadow.camera.far = 50;
        this.sunLight.shadow.camera.left = -20;
        this.sunLight.shadow.camera.right = 20;
        this.sunLight.shadow.camera.top = 20;
        this.sunLight.shadow.camera.bottom = -20;
        this.scene.add(this.sunLight);

        this.hemiLight = new THREE.HemisphereLight(
            this.params.skyColorTop,
            this.params.groundColor,
            0.6
        );
        this.scene.add(this.hemiLight);
    }

    initSky() {
        // Simple background color for now, could be improved with a shader sky
        this.scene.background = new THREE.Color(this.params.skyColorTop);
        this.scene.fog = new THREE.Fog(this.params.skyColorTop, 10, 50);
    }

    setupGUI() {
        const folder = this.gui.addFolder('Environment');
        folder.add(this.params, 'timeOfDay', 0, 24).onChange(() => this.updateSunPosition());
        folder.add(this.params, 'timeSpeed', 0, 2.0);
        folder.addColor(this.params, 'sunColor').onChange(v => this.sunLight.color.set(v));
    }

    update(elapsedTime, delta) {
        // Auto-increment time
        this.params.timeOfDay += delta * this.params.timeSpeed;
        if (this.params.timeOfDay > 24) this.params.timeOfDay -= 24;

        this.updateSunPosition();
        this.updateColors();
    }

    updateSunPosition() {
        const time = this.params.timeOfDay;
        // Map 0-24 to 0-2PI, starting at sunrise/sunset
        // Let's say 6am is sunrise (0), 12 is noon (PI/2), 18 is sunset (PI).
        // Angle = (time - 6) / 24 * 2PI * something?
        // Simpler: 
        // Noon (12) -> Y is max. 
        // 0/24 -> Y is min (night).

        const angle = ((time - 6) / 24) * Math.PI * 2;
        const radius = 20;

        this.sunLight.position.x = Math.cos(angle) * radius;
        this.sunLight.position.y = Math.sin(angle) * radius;
        this.sunLight.position.z = 10; // Slight offset

        this.sunLight.lookAt(0, 0, 0);
    }

    updateColors() {
        // Basic Day/Night cycle logic for colors
        const hours = this.params.timeOfDay;
        const isDay = hours > 6 && hours < 18;
        const isDawnDusk = (hours > 5 && hours < 7) || (hours > 17 && hours < 19);

        let targetSky = new THREE.Color(this.params.skyColorTop);
        let targetFog = new THREE.Color(this.params.skyColorTop);

        if (!isDay && !isDawnDusk) {
            // Night
            targetSky.set('#000022');
            targetFog.set('#000022');
            this.sunLight.intensity = 0;
            this.hemiLight.intensity = 0.2;
        } else if (isDawnDusk) {
            // Orange-ish
            targetSky.set('#ff9966');
            targetFog.set('#ff9966');
            this.sunLight.intensity = 0.5;
            this.hemiLight.intensity = 0.5;
        } else {
            // Day
            this.sunLight.intensity = 2.0;
            this.hemiLight.intensity = 0.6;
            targetFog.set('#87CEEB'); // Restore original blue
        }

        // Smoothly interpolate would be better, but direct set for now
        this.scene.background.lerp(targetSky, 0.05);
        this.scene.fog.color.lerp(targetFog, 0.05);
    }
}
