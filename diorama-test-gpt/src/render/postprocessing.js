import * as THREE from "three";

import { clamp } from "../utils/math.js";

export function createPostProcessing({ renderer, scene, camera, sim, sunDir, pixelRatioCap = 2 } = {}) {
  if (!renderer) throw new Error("createPostProcessing: missing renderer");
  if (!scene) throw new Error("createPostProcessing: missing scene");
  if (!camera) throw new Error("createPostProcessing: missing camera");
  if (!sim) throw new Error("createPostProcessing: missing sim");
  if (!sunDir) throw new Error("createPostProcessing: missing sunDir");

  let pixelRatioCapValue = pixelRatioCap;
  let tiltShiftScale = 0.55;

  let tiltSceneRT = null;
  let tiltBlurRT1 = null;
  let tiltBlurRT2 = null;
  let tiltMixRT = null;
  let starsRT = null;

  const starsScene = new THREE.Scene();

  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  postScene.add(postQuad);

  const blurMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tInput: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uDirection: { value: new THREE.Vector2(1, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tInput;
      uniform vec2 uResolution;
      uniform vec2 uDirection;

      void main() {
        vec2 texel = 1.0 / max(uResolution, vec2(1.0));
        vec2 d = uDirection * texel;

        vec3 c = vec3(0.0);
        c += texture2D(tInput, vUv - 4.0 * d).rgb * 0.06;
        c += texture2D(tInput, vUv - 2.0 * d).rgb * 0.24;
        c += texture2D(tInput, vUv).rgb * 0.40;
        c += texture2D(tInput, vUv + 2.0 * d).rgb * 0.24;
        c += texture2D(tInput, vUv + 4.0 * d).rgb * 0.06;

        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });

  const tiltCompositeMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: false,
    toneMapped: false,
    uniforms: {
      tScene: { value: null },
      tBlur: { value: null },
      uFocusY: { value: 0.56 },
      uBand: { value: 0.12 },
      uFalloff: { value: 0.22 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tBlur;
      uniform float uFocusY;
      uniform float uBand;
      uniform float uFalloff;

      #include <common>

      void main() {
        vec3 sharp = texture2D(tScene, vUv).rgb;
        vec3 blur = texture2D(tBlur, vUv).rgb;
        float d = abs(vUv.y - uFocusY);
        float m = smoothstep(uBand, uBand + uFalloff, d);
        vec3 col = mix(sharp, blur, m);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  function makePostRT(scale, depthBuffer = false) {
    const pr = Math.min(window.devicePixelRatio || 1, pixelRatioCapValue);
    const w = Math.max(2, Math.floor(window.innerWidth * pr * scale));
    const h = Math.max(2, Math.floor(window.innerHeight * pr * scale));
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    if (depthBuffer) {
      rt.depthTexture = new THREE.DepthTexture(w, h);
      rt.depthTexture.format = THREE.DepthFormat;
      rt.depthTexture.type = renderer.capabilities.isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
    }
    return rt;
  }

  function resizeTargets() {
    if (tiltSceneRT) tiltSceneRT.dispose();
    if (tiltBlurRT1) tiltBlurRT1.dispose();
    if (tiltBlurRT2) tiltBlurRT2.dispose();
    if (tiltMixRT) tiltMixRT.dispose();
    if (starsRT) starsRT.dispose();
    tiltSceneRT = makePostRT(1.0, true);
    tiltMixRT = makePostRT(1.0, false);
    tiltBlurRT1 = makePostRT(tiltShiftScale, false);
    tiltBlurRT2 = makePostRT(tiltShiftScale, false);
    starsRT = makePostRT(1.0, false);
    blurMat.uniforms.uResolution.value.set(tiltBlurRT1.texture.image.width, tiltBlurRT1.texture.image.height);
  }

  const finalCompositeMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: false,
    toneMapped: false,
    uniforms: {
      tScene: { value: null },
      tDepth: { value: null },
      tStars: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 1000.0 },
      uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      uSunVisible: { value: 0 },
      uTime: { value: 0 },
      uDay: { value: 1 },
      uCloud: { value: 0.25 },
      uMood: { value: 0 }, // 0 normal, 1 golden, 2 storm
      uOutlineStrength: { value: 0.7 },
      uAOStrength: { value: 0.55 },
      uRaysStrength: { value: 0.65 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
	    precision highp float;
	    varying vec2 vUv;
	    uniform sampler2D tScene;
	    uniform sampler2D tDepth;
	    uniform sampler2D tStars;
	    uniform vec2 uResolution;
	    uniform float uNear;
	    uniform float uFar;
    uniform vec2 uSunUv;
    uniform float uSunVisible;
    uniform float uTime;
    uniform float uDay;
    uniform float uCloud;
    uniform float uMood;
    uniform float uOutlineStrength;
    uniform float uAOStrength;
    uniform float uRaysStrength;

	    #include <common>
	    #include <packing>

    float luma(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float viewZ(float depth) {
      return perspectiveDepthToViewZ(depth, uNear, uFar);
    }

    void main() {
      vec2 texel = 1.0 / max(uResolution, vec2(1.0));
      vec3 col = texture2D(tScene, vUv).rgb;

      // Outline from depth discontinuities (with a small luma assist).
      float d0 = texture2D(tDepth, vUv).x;
      float vz0 = viewZ(d0);
      float vz1 = viewZ(texture2D(tDepth, vUv + vec2(texel.x, 0.0)).x);
      float vz2 = viewZ(texture2D(tDepth, vUv + vec2(-texel.x, 0.0)).x);
      float vz3 = viewZ(texture2D(tDepth, vUv + vec2(0.0, texel.y)).x);
      float vz4 = viewZ(texture2D(tDepth, vUv + vec2(0.0, -texel.y)).x);
      float dd = max(max(abs(vz1 - vz0), abs(vz2 - vz0)), max(abs(vz3 - vz0), abs(vz4 - vz0)));

      float l0 = luma(col);
      float l1 = luma(texture2D(tScene, vUv + vec2(texel.x, 0.0)).rgb);
      float l2 = luma(texture2D(tScene, vUv + vec2(-texel.x, 0.0)).rgb);
      float l3 = luma(texture2D(tScene, vUv + vec2(0.0, texel.y)).rgb);
      float l4 = luma(texture2D(tScene, vUv + vec2(0.0, -texel.y)).rgb);
      float ld = max(max(abs(l1 - l0), abs(l2 - l0)), max(abs(l3 - l0), abs(l4 - l0)));

      float edge = max(smoothstep(0.28, 1.55, dd), smoothstep(0.10, 0.22, ld));
      col *= 1.0 - edge * clamp(uOutlineStrength, 0.0, 1.0) * 0.55;

      // Cheap SSAO from depth (stable, small kernel).
      if (uAOStrength > 0.001) {
        float r = hash12(vUv * uResolution + uTime * 0.17);
        float ang = r * 6.2831853;
        mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));

        float occ = 0.0;
        float wsum = 0.0;
        float radius = mix(1.8, 3.2, 1.0 - uDay);
        float bias = 0.55;

        for (int i = 0; i < 8; i++) {
          float fi = float(i);
          float a = (fi / 8.0) * 6.2831853;
          vec2 dir = rot * vec2(cos(a), sin(a));
          vec2 off = dir * texel * radius * (1.0 + fi * 0.35);
          float ds = texture2D(tDepth, vUv + off).x;
          float vz = viewZ(ds);
          // In view space (negative Z), "closer" means less negative (greater value).
          float o = step(0.0, (vz - vz0) - bias);
          float w = 1.0 - (fi / 8.0);
          occ += o * w;
          wsum += w;
        }
        float ao = 1.0 - (occ / max(wsum, 1e-3));
        col *= mix(1.0, ao, clamp(uAOStrength, 0.0, 1.0));
      }

      // Screen-space sun rays (radial gather towards the sun).
      if (uSunVisible > 0.5 && uRaysStrength > 0.001) {
        vec2 dir = uSunUv - vUv;
        float dist = length(dir);
        vec2 stepUv = dir / float(18);
        vec2 uv = vUv;

        float illum = 0.0;
        float decay = 1.0;
        for (int i = 0; i < 18; i++) {
          uv += stepUv;
          vec3 s = texture2D(tScene, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
          float b = max(0.0, luma(s) - 0.62);
          illum += b * decay;
          decay *= 0.94;
        }
        float ray = (illum / 18.0) * (1.0 - smoothstep(0.0, 0.65, dist));
        ray *= uDay * (1.0 - uCloud * 0.85);
        vec3 rayCol = mix(vec3(1.0, 0.90, 0.75), vec3(0.78, 0.86, 1.0), smoothstep(1.0, 2.0, uMood));
        col += rayCol * ray * clamp(uRaysStrength, 0.0, 1.0) * 0.85;
      }

      // Simple grading per mood.
      vec3 tint = vec3(1.0);
      float sat = 1.0;
      float cont = 1.0;
      if (uMood > 0.5 && uMood < 1.5) {
        // golden hour
        tint = vec3(1.12, 1.03, 0.90);
        sat = 1.08;
        cont = 1.05;
      } else if (uMood >= 1.5) {
        // storm
        tint = vec3(0.90, 0.98, 1.12);
        sat = 0.92;
        cont = 1.10;
      }
      vec3 g = vec3(luma(col));
      col = mix(g, col, sat);
      col = (col - 0.5) * cont + 0.5;
      col *= tint;

		      gl_FragColor = vec4(col, 1.0);

		      // Add stars in post so they stay crisp/bright in the post pipeline.
		      vec3 stars = texture2D(tStars, vUv).rgb;
		      // Only show stars where nothing wrote depth (background). A strict threshold avoids stars
		      // leaking onto far terrain/water when depth gets close to 1.0.
		      float skyMask = step(0.999995, d0);
		      gl_FragColor.rgb += stars * skyMask;

	      #include <colorspace_fragment>
	    }
	  `,
  });

  function renderTiltShiftComposite() {
    tiltCompositeMat.uniforms.uFocusY.value = clamp(sim.tiltFocus, 0.0, 1.0);

    postQuad.material = blurMat;
    blurMat.uniforms.tInput.value = tiltSceneRT.texture;
    blurMat.uniforms.uResolution.value.set(tiltSceneRT.texture.image.width, tiltSceneRT.texture.image.height);
    blurMat.uniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(tiltBlurRT1);
    renderer.render(postScene, postCam);

    blurMat.uniforms.tInput.value = tiltBlurRT1.texture;
    blurMat.uniforms.uResolution.value.set(tiltBlurRT1.texture.image.width, tiltBlurRT1.texture.image.height);
    blurMat.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(tiltBlurRT2);
    renderer.render(postScene, postCam);

    postQuad.material = tiltCompositeMat;
    tiltCompositeMat.uniforms.tScene.value = tiltSceneRT.texture;
    tiltCompositeMat.uniforms.tBlur.value = tiltBlurRT2.texture;
    renderer.setRenderTarget(tiltMixRT);
    renderer.render(postScene, postCam);
    renderer.setRenderTarget(null);

    return tiltMixRT.texture;
  }

  const tmpSunNdc = new THREE.Vector3();
  function updateFinalCompositeUniforms(timeMeta, tReal) {
    finalCompositeMat.uniforms.uTime.value = tReal;
    finalCompositeMat.uniforms.uNear.value = camera.near;
    finalCompositeMat.uniforms.uFar.value = camera.far;
    finalCompositeMat.uniforms.uDay.value = timeMeta?.day ?? 1;
    finalCompositeMat.uniforms.uCloud.value = clamp(sim.cloudiness, 0, 1);
    finalCompositeMat.uniforms.uMood.value = sim.mood === "golden" ? 1 : sim.mood === "storm" ? 2 : 0;

    const w = tiltSceneRT?.texture?.image?.width || 1;
    const h = tiltSceneRT?.texture?.image?.height || 1;
    finalCompositeMat.uniforms.uResolution.value.set(w, h);

    tmpSunNdc.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
    const sunVisible = tmpSunNdc.z > -1 && tmpSunNdc.z < 1 ? 1 : 0;
    finalCompositeMat.uniforms.uSunVisible.value = sunVisible;
    finalCompositeMat.uniforms.uSunUv.value.set(tmpSunNdc.x * 0.5 + 0.5, tmpSunNdc.y * 0.5 + 0.5);
  }

  function renderFrame(timeMeta, tReal) {
    if (!tiltSceneRT || !starsRT) resizeTargets();

    renderer.setRenderTarget(tiltSceneRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    renderer.setRenderTarget(starsRT);
    renderer.render(starsScene, camera);
    renderer.setRenderTarget(null);

    let src = tiltSceneRT.texture;
    if (sim.cameraMode === "tiltshift") src = renderTiltShiftComposite();

    updateFinalCompositeUniforms(timeMeta, tReal);
    postQuad.material = finalCompositeMat;
    finalCompositeMat.uniforms.tScene.value = src;
    finalCompositeMat.uniforms.tDepth.value = tiltSceneRT.depthTexture;
    finalCompositeMat.uniforms.tStars.value = starsRT.texture;
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  }

  const tmpMainResolution = new THREE.Vector2();
  function getMainResolution() {
    const w = tiltSceneRT?.texture?.image?.width;
    const h = tiltSceneRT?.texture?.image?.height;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return tmpMainResolution.set(w, h);
    renderer.getDrawingBufferSize(tmpMainResolution);
    return tmpMainResolution;
  }

  function setTiltShiftScale(nextScale) {
    if (Number.isFinite(nextScale) && nextScale > 0) tiltShiftScale = nextScale;
    if (tiltSceneRT || tiltBlurRT1 || tiltBlurRT2 || tiltMixRT || starsRT) resizeTargets();
  }

  function setPixelRatioCap(nextCap) {
    if (!Number.isFinite(nextCap) || nextCap <= 0) return;
    pixelRatioCapValue = nextCap;
    if (tiltSceneRT || tiltBlurRT1 || tiltBlurRT2 || tiltMixRT || starsRT) resizeTargets();
  }

  return Object.freeze({
    starsScene,
    resizeTargets,
    renderFrame,
    getMainResolution,
    setTiltShiftScale,
    setPixelRatioCap,
  });
}
