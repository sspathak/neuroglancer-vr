/**
 * VRZarr — Stereoscopic 3D Neuroglancer Viewer Controller
 *
 * Manages two synchronized same-origin Neuroglancer instances (Left Eye & Right Eye),
 * injects camera-relative 3D stereoscopic baseline + convergence offsets directly into
 * each eye's PerspectivePanel view matrix, and synchronizes all 3D navigation & layer state.
 */

(function () {
  'use strict';

  // ============================================================================
  // 1. Stereo & Rendering Configuration State
  // ============================================================================
  const stereoState = {
    separationPercent: 5.5,   // Camera-relative horizontal eye separation (% of 3D view scale)
    convergencePercent: 90,   // 0% = parallel shift, 100% = converged on 3D crosshair focal point
    perspectiveFovDeg: 72,    // Manual 3D perspective field-of-view / distortion angle (30°..120°)
    autoDollyPercent: 80,     // 0% = flat scaling zoom, 100% = full 3D dolly + perspective distortion on zoom
    referenceScale: 960,      // Baseline projectionScale of the active dataset for zoom-ratio calculation
    swapEyes: false,          // false = Parallel (L/R), true = Cross-Eye (R/L)
    renderMode: 'volume_only', // 'volume_only' | 'volume_and_slices' | 'mip_only' | 'slices_only'
    volumeGain: -0.6,
    colormap: 'amber',        // 'amber' | 'grayscale' | 'cyan' | 'emerald'
    autoOrbit: false,
    showNgUi: false,
    zoomRelative: true,       // Zoom-relative depth range mode (scales depth step with zoom)
    depthSamples: 256,        // 3D volume raycast depth sampling resolution (128..1024)
    aspectCorrection: 1.0,    // Aspect ratio correction (1.0 = Normal/Cardboard, 0.5 = Quest 2:1 SBS Stretch Fix)
    cuboidLimit: {
      enabled: false,         // 3D Cuboid subvolume limit (drastically cuts chunk fetching for Quest)
      size: 512,              // Extent in voxels (256, 384, 512, 768, 1024)
      center: null,           // [x, y, z] in voxels (null = defaults to viewer.position)
      showCage: true,         // Show cyan 3D wireframe bounding box cage
    },
    activePreset: 'escargot',
  };

  // Neuroglancer internal enum for ImageUserLayer.volumeRenderingMode:
  // OFF = 0, ON = 1, MAX = 2, MIN = 3
  const VOLUME_MODE_ENUM = {
    slices_only: 0,       // OFF
    volume_and_slices: 1, // ON
    volume_only: 1,       // ON
    mip_only: 2,          // MAX
  };

  // Must be quoted CSS/hex color strings for Neuroglancer's `#uicontrol vec3 color(default="...")`
  const COLORMAPS = {
    amber:     '#ffdca3',
    grayscale: '#ffffff',
    cyan:      '#61e0ff',
    emerald:   '#59f5ad',
  };

  const CROSS_SECTIONS_SPEC = {
    xy: {},
    xz: { orientation: [0.70710678, 0, 0, 0.70710678] },
  };

  // ============================================================================
  // 2. Built-in 3D Dataset Presets
  // ============================================================================
  function buildVolumeShader(rangeMin, rangeMax, hexColor) {
    const c = hexColor || '#ffdca3';
    return `#uicontrol invlerp contrast(range=[${rangeMin}, ${rangeMax}], window=[${rangeMin}, ${rangeMax}])
#uicontrol vec3 color color(default="${c}")
void main() {
  float v = contrast();
  if (VOLUME_RENDERING) {
    float alpha = clamp(v * v * 0.28, 0.0, 1.0);
    emitRGBA(vec4(color * v, alpha));
  } else {
    emitRGB(color * v);
  }
}`;
  }

  function buildLayoutSpec(renderMode) {
    const showSlices =
      renderMode === 'volume_and_slices' || renderMode === 'slices_only';
    if (showSlices) {
      return {
        type: '3d',
        crossSections: CROSS_SECTIONS_SPEC,
      };
    }
    return '3d';
  }

  const PRESETS = {
    escargot: {
      label: 'Escargot (QIM Micro-CT)',
      url: 'https://public.qim.dk/escargot/escargot.zarr/',
      defaultGain: -0.6,
      // Semi-translucent CT transfer function so internal spiral whorls shine in 3D stereo
      range: [12.0, 105.0],
      buildState(colormap, renderMode, volumeGain) {
        const hex = COLORMAPS[colormap] || COLORMAPS.amber;
        const volMode =
          renderMode === 'slices_only' ? 'off' :
          renderMode === 'mip_only' ? 'max' : 'on';
        const showSlices = renderMode === 'volume_and_slices' || renderMode === 'slices_only';
        return {
          dimensions: {
            x: [1, ''],
            y: [1, ''],
            z: [1, ''],
          },
          position: [500, 500, 350],
          crossSectionScale: 1.5,
          projectionOrientation: [-0.24, 0.19, 0.08, 0.95],
          projectionScale: 960,
          showSlices: showSlices,
          hideCrossSectionBackground3D: true,
          showAxisLines: false,
          showScaleBar: false,
          perspectiveViewBackgroundColor: '#05070b',
          layout: buildLayoutSpec(renderMode),
          layers: [
            {
              type: 'image',
              name: 'escargot_microct',
              source: 'zarr://https://public.qim.dk/escargot/escargot.zarr/',
              volumeRendering: volMode,
              volumeRenderingGain: volumeGain,
              volumeRenderingDepthSamples: 192,
              shader: buildVolumeShader(12.0, 105.0, hex),
            },
          ],
        };
      },
    },

    hipct: {
      label: 'Human Brain Left Hemisphere (UCL HiP-CT 20.07 µm)',
      url: 'gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/I74/brain-left_hemisphere/20.07um_overview_bm18.ome.zarr',
      defaultGain: 0.2,
      // Thresholds out the mounting jar medium (~28000) to reveal the 3D cortical folds (29000..34600)
      range: [29000, 34600],
      buildState(colormap, renderMode, volumeGain) {
        const hex = COLORMAPS[colormap] || COLORMAPS.amber;
        const volMode =
          renderMode === 'slices_only' ? 'off' :
          renderMode === 'mip_only' ? 'max' : 'on';
        const showSlices = renderMode === 'volume_and_slices' || renderMode === 'slices_only';
        return {
          dimensions: {
            x: [2.007e-5, 'm'],
            y: [2.007e-5, 'm'],
            z: [2.007e-5, 'm'],
          },
          position: [3784.5, 3784.5, 4257],
          crossSectionScale: 8.0,
          projectionOrientation: [-0.52, 0.42, 0.46, 0.58],
          projectionScale: 8200,
          showSlices: showSlices,
          hideCrossSectionBackground3D: true,
          showAxisLines: false,
          showScaleBar: false,
          perspectiveViewBackgroundColor: '#05070b',
          layout: buildLayoutSpec(renderMode),
          layers: [
            {
              type: 'image',
              name: 'brain_left_hemisphere_20um',
              source:
                'zarr://gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/I74/brain-left_hemisphere/20.07um_overview_bm18.ome.zarr',
              volumeRendering: volMode,
              volumeRenderingGain: volumeGain,
              volumeRenderingDepthSamples: 192,
              shader: buildVolumeShader(29000, 34600, hex),
            },
          ],
        };
      },
    },

    heart: {
      label: 'Human Heart (UCL HiP-CT 8.01 µm)',
      url: 'gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/LADAF-2021-17/heart/8.01um_complete-organ_bm18.ome.zarr/',
      defaultGain: 0.0,
      // HiP-CT 8.01 µm whole organ scan, calibrated range reveals soft tissue, myocardial fibers, and coronary vasculature
      range: [18192, 29950],
      buildState(colormap, renderMode, volumeGain) {
        const hex = COLORMAPS[colormap] || COLORMAPS.amber;
        const volMode =
          renderMode === 'slices_only' ? 'off' :
          renderMode === 'mip_only' ? 'max' : 'on';
        const showSlices = renderMode === 'volume_and_slices' || renderMode === 'slices_only';
        return {
          dimensions: {
            x: [8.01e-6, 'm'],
            y: [8.01e-6, 'm'],
            z: [8.01e-6, 'm'],
          },
          position: [5928, 6800, 9496],
          crossSectionScale: 10,
          projectionOrientation: [0.309426397, 0.206284255, 0, -0.928279102],
          projectionScale: 4096,
          showSlices: showSlices,
          hideCrossSectionBackground3D: true,
          showAxisLines: false,
          showScaleBar: false,
          perspectiveViewBackgroundColor: '#05070b',
          layout: buildLayoutSpec(renderMode),
          layers: [
            {
              type: 'image',
              name: 'LADAF-2021-17_heart_complete-organ_8.01um_bm18',
              source:
                'zarr://gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/LADAF-2021-17/heart/8.01um_complete-organ_bm18.ome.zarr/',
              volumeRendering: volMode,
              volumeRenderingGain: volumeGain,
              volumeRenderingDepthSamples: 256,
              shaderControls: {
                normalized: { range: [18192, 29950], window: [18192, 29950] },
                contrast: { range: [18192, 29950], window: [18192, 29950] },
              },
              shader: buildVolumeShader(18192, 29950, hex),
            },
          ],
        };
      },
    },
  };

  // ============================================================================
  // 3. DOM Elements & Viewer References
  // ============================================================================
  const iframeLeft = document.getElementById('iframe-left');
  const iframeRight = document.getElementById('iframe-right');
  const reticleLeft = document.getElementById('reticle-left');
  const reticleRight = document.getElementById('reticle-right');
  const toastLeft = document.getElementById('toast-left');
  const toastRight = document.getElementById('toast-right');
  const badgeLeft = document.getElementById('badge-left');
  const badgeRight = document.getElementById('badge-right');

  const syncDot = document.getElementById('sync-dot');
  const syncLabel = document.getElementById('sync-label');

  const sliderSeparation = document.getElementById('slider-separation');
  const valSeparation = document.getElementById('val-separation');
  const sliderConvergence = document.getElementById('slider-convergence');
  const valConvergence = document.getElementById('val-convergence');
  const sliderPerspective = document.getElementById('slider-perspective');
  const valPerspective = document.getElementById('val-perspective');
  const sliderDolly = document.getElementById('slider-dolly');
  const valDolly = document.getElementById('val-dolly');
  const selectRenderMode = document.getElementById('select-render-mode');
  const valRenderMode = document.getElementById('val-render-mode');
  const sliderGain = document.getElementById('slider-gain');
  const valGain = document.getElementById('val-gain');
  const selectColormap = document.getElementById('select-colormap');

  const customSourceInput = document.getElementById('custom-source-input');
  const btnLoadCustom = document.getElementById('btn-load-custom');
  const presetEscargotBtn = document.getElementById('preset-escargot');
  const presetHipctBtn = document.getElementById('preset-hipct');
  const presetHeartBtn = document.getElementById('preset-heart');

  const btnAutoOrbit = document.getElementById('btn-auto-orbit');
  const btnSwapEyes = document.getElementById('btn-swap-eyes');
  const btnLensFrame = document.getElementById('btn-lens-frame');
  const btnNgUi = document.getElementById('btn-ng-ui');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnEnterWebXR = document.getElementById('btn-enter-webxr');
  const btnToggleZoomRelative = document.getElementById('btn-toggle-zoom-relative');
  const valZoomRelative = document.getElementById('val-zoom-relative');
  const selectDepthSamples = document.getElementById('select-depth-samples');
  const valDepthSamples = document.getElementById('val-depth-samples');
  const btnCycleRes = document.getElementById('btn-cycle-res');
  const sliderAspect = document.getElementById('slider-aspect');
  const valAspect = document.getElementById('val-aspect');
  const btnToggleAspect = document.getElementById('btn-toggle-aspect');
  const btnAspectFix = document.getElementById('btn-aspect-fix');
  const btnCuboidLimit = document.getElementById('btn-cuboid-limit');
  const btnToggleCuboid = document.getElementById('btn-toggle-cuboid');
  const btnCenterCuboid = document.getElementById('btn-center-cuboid');
  const selectCuboidSize = document.getElementById('select-cuboid-size');
  const btnCuboidCage = document.getElementById('btn-cuboid-cage');
  const valCuboid = document.getElementById('val-cuboid');
  const btnCloseHud = document.getElementById('btn-close-hud');
  const btnGyroTrack = document.getElementById('btn-gyro-track');
  const landscapePrompt = document.getElementById('landscape-prompt');
  const btnRotateFs = document.getElementById('btn-rotate-fs');
  const hudToggleBtn = document.getElementById('hud-toggle-btn');
  const stereoStage = document.getElementById('stereo-stage');

  let leftViewer = null;
  let rightViewer = null;
  let isSyncingNav = false;
  let isSyncingState = false;
  let toastTimer = null;

  // ============================================================================
  // 4. Dual-Eye Stereo Toast Notification (Readable inside VR Headset)
  // ============================================================================
  function showStereoToast(message) {
    if (!toastLeft || !toastRight) return;
    toastLeft.textContent = message;
    toastRight.textContent = message;
    toastLeft.classList.add('visible');
    toastRight.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastLeft.classList.remove('visible');
      toastRight.classList.remove('visible');
    }, 1500);
  }

  // ============================================================================
  // 5. Camera-Relative Stereoscopic 3D Matrix & True 3D Dolly Perspective Hook
  // ============================================================================
  function computeEffectiveProjection(viewer, rawZoomFactor) {
    const currentScale = viewer?.projectionScale?.value;
    const refScale = stereoState.referenceScale > 0 ? stereoState.referenceScale : currentScale;

    let zoomRatio = 1.0;
    if (
      Number.isFinite(currentScale) &&
      currentScale > 0 &&
      Number.isFinite(refScale) &&
      refScale > 0
    ) {
      zoomRatio = Math.max(0.05, Math.min(50.0, refScale / currentScale));
    }

    const dollyStrength = stereoState.autoDollyPercent / 100;
    const log2Zoom = Math.log2(zoomRatio);

    // 1. Dynamic 3D Perspective Field-of-View (FOV):
    // Widens automatically when zooming in (`zoomRatio > 1`) so the virtual camera
    // physically approaches the 3D object and induces real perspective foreshortening.
    const autoFovBoostDeg = dollyStrength * 46.0 * Math.tanh(0.65 * log2Zoom);
    const effectiveFovDeg = Math.max(
      28,
      Math.min(126, stereoState.perspectiveFovDeg + autoFovBoostDeg)
    );
    const fovRad = (effectiveFovDeg * Math.PI) / 180;

    // 2. 3D Dolly vs. 2D Uniform Scale Conversion:
    // Softens pure 2D screen scaling when zooming in so the camera can move right up to
    // the front surface of the 3D object while keeping the object framed in perspective.
    const zoom =
      zoomRatio > 1.0 && dollyStrength > 0
        ? rawZoomFactor * Math.pow(zoomRatio, 0.38 * dollyStrength)
        : rawZoomFactor;

    // 3. Zoom-Adaptive Stereo Comfort & Parallax Stabilization:
    // Prevents zooming in from causing runaway divergent disparity (double vision)
    // and prevents zooming out from flattening the 3D stereo depth to zero.
    const zEff =
      zoomRatio > 1.0 ? Math.pow(zoomRatio, 1.0 - 0.38 * dollyStrength) : zoomRatio;
    const fovRatio = Math.tan(fovRad * 0.5) / Math.tan((72 * Math.PI) / 360);
    const stereoZoomCompensation = Math.max(
      0.14,
      Math.min(2.6, Math.pow(zEff, -0.72) * Math.pow(fovRatio, -0.45))
    );

    return {
      fov: fovRad,
      fovDeg: effectiveFovDeg,
      zoom,
      zoomRatio,
      stereoZoomCompensation,
    };
  }

  function installStereoCameraHook(iframeEl, viewer, eyeSign) {
    const win = iframeEl?.contentWindow;
    if (win) {
      win.vrStereoHook = function (panelNavState, panel, projParams) {
        const rawZoom =
          panelNavState?.zoomFactor?.value ??
          viewer?.perspectiveNavigationState?.zoomFactor?.value ??
          960;
        const proj = computeEffectiveProjection(viewer, rawZoom);

        const effectiveSign = eyeSign * (stereoState.swapEyes ? -1 : 1);
        const baseHalfShift = effectiveSign * (stereoState.separationPercent / 100) * 0.5;
        const halfShift = baseHalfShift * proj.stereoZoomCompensation;
        const convFraction = stereoState.convergencePercent / 100;

        let aspect = null;
        if (projParams?.logicalWidth && projParams?.logicalHeight) {
          const rawAspect = projParams.logicalWidth / projParams.logicalHeight;
          const correction = Number.isFinite(stereoState.aspectCorrection)
            ? stereoState.aspectCorrection
            : 1.0;
          aspect = rawAspect * correction;
        }

        return {
          fov: proj.fov,
          zoom: proj.zoom,
          aspect: aspect,
          applyShift(invViewMatrix, d, t) {
            // 1. Orbital toe-in / convergence component around the 3D focal point
            const theta = -Math.atan(halfShift * convFraction);
            if (Math.abs(theta) > 1e-6) {
              const cosT = Math.cos(theta);
              const sinT = Math.sin(theta);
              for (let row = 0; row < 3; row++) {
                const rx = invViewMatrix[row];
                const rz = invViewMatrix[8 + row];
                invViewMatrix[row] = rx * cosT - rz * sinT;
                invViewMatrix[8 + row] = rx * sinT + rz * cosT;
              }
            }

            // 2. Lateral shift component along the camera's local Right axis
            invViewMatrix[12] += halfShift * invViewMatrix[0];
            invViewMatrix[13] += halfShift * invViewMatrix[1];
            invViewMatrix[14] += halfShift * invViewMatrix[2];
          },
        };
      };
    }

    // Make plain mouse wheel in the 3D view perform 3D Dolly Zoom (Shift+Wheel still moves slice plane)
    if (viewer.inputEventBindings?.perspectiveView?.set) {
      viewer.inputEventBindings.perspectiveView.set('at:wheel', {
        action: 'zoom-via-wheel',
        preventDefault: true,
      });
    }
  }

  function updateDollyBadge() {
    if (!valPerspective || !valDolly) return;
    if (leftViewer && stereoState.autoDollyPercent > 0) {
      const proj = computeEffectiveProjection(
        leftViewer,
        leftViewer.perspectiveNavigationState.zoomFactor.value
      );
      const effDeg = Math.round(proj.fovDeg);
      if (Math.abs(effDeg - stereoState.perspectiveFovDeg) >= 1) {
        valPerspective.textContent = `${stereoState.perspectiveFovDeg}° → ${effDeg}°`;
      } else {
        valPerspective.textContent = `${stereoState.perspectiveFovDeg}°`;
      }
    } else {
      valPerspective.textContent = `${stereoState.perspectiveFovDeg}°`;
    }
    valDolly.textContent =
      stereoState.autoDollyPercent > 0
        ? `${stereoState.autoDollyPercent}% (Auto)`
        : '0% (Flat)';
  }

  function refreshStereoProjection() {
    if (!leftViewer || !rightViewer) return;
    updateDollyBadge();

    for (const viewer of [leftViewer, rightViewer]) {
      if (!viewer || !viewer.display) continue;
      for (const panel of viewer.display.panels) {
        if (panel.projectionParameters) {
          panel.projectionParameters.update();
          panel.projectionParameters.update.flush();
        }
      }
      viewer.display.scheduleRedraw();
    }
  }

  // ============================================================================
  // 6. Lockstep Bidirectional Navigation & State Synchronization
  // ============================================================================
  function copyNavigationFromTo(source, target) {
    if (isSyncingNav || !source || !target) return;
    if (!source.position.valid || !target.position.valid) return;

    const srcPhys = source.projectionScale.canonicalVoxelPhysicalSize;
    const dstPhys = target.projectionScale.canonicalVoxelPhysicalSize;
    if (!srcPhys || !dstPhys || Math.abs(srcPhys - dstPhys) / srcPhys > 1e-6) {
      return;
    }

    isSyncingNav = true;
    try {
      if (source.display?.isContinuousCameraMotionInProgress) {
        target.display?.flagContinuousCameraMotion?.();
      }

      // 1. 3D Focal & Cross-Section Position
      const srcPos = source.position.value;
      const dstPos = target.position.value;
      if (srcPos.length === dstPos.length) {
        let posDiff = false;
        for (let i = 0; i < srcPos.length; i++) {
          if (srcPos[i] !== dstPos[i]) {
            dstPos[i] = srcPos[i];
            posDiff = true;
          }
        }
        if (posDiff) target.position.changed.dispatch();
      }

      // 2. 3D Perspective Orientation Quaternion
      const srcProjQuat = source.projectionOrientation.orientation;
      const dstProjQuat = target.projectionOrientation.orientation;
      if (
        srcProjQuat[0] !== dstProjQuat[0] ||
        srcProjQuat[1] !== dstProjQuat[1] ||
        srcProjQuat[2] !== dstProjQuat[2] ||
        srcProjQuat[3] !== dstProjQuat[3]
      ) {
        dstProjQuat.set(srcProjQuat);
        target.projectionOrientation.changed.dispatch();
      }

      // 3. 3D Perspective Zoom Scale & Depth Range
      const srcScaleVal = source.projectionScale.value;
      if (
        Number.isFinite(srcScaleVal) &&
        srcScaleVal > 0 &&
        srcScaleVal !== target.projectionScale.value
      ) {
        if (!stereoState.referenceScale || stereoState.referenceScale <= 0) {
          stereoState.referenceScale = srcScaleVal;
        }
        target.projectionScale.value = srcScaleVal;
        updateDollyBadge();
      }

      const srcDepthVal = source.projectionDepthRange.value;
      if (
        Number.isFinite(srcDepthVal) &&
        srcDepthVal !== target.projectionDepthRange.value
      ) {
        target.projectionDepthRange.value = srcDepthVal;
      }

      // 4. Cross-Section 2D Slice Orientation & Scale
      const srcCrossQuat = source.crossSectionOrientation.orientation;
      const dstCrossQuat = target.crossSectionOrientation.orientation;
      if (
        srcCrossQuat[0] !== dstCrossQuat[0] ||
        srcCrossQuat[1] !== dstCrossQuat[1] ||
        srcCrossQuat[2] !== dstCrossQuat[2] ||
        srcCrossQuat[3] !== dstCrossQuat[3]
      ) {
        dstCrossQuat.set(srcCrossQuat);
        target.crossSectionOrientation.changed.dispatch();
      }

      const srcCrossScale = source.crossSectionScale.value;
      if (
        Number.isFinite(srcCrossScale) &&
        srcCrossScale > 0 &&
        srcCrossScale !== target.crossSectionScale.value
      ) {
        target.crossSectionScale.value = srcCrossScale;
      }

      target.display.scheduleRedraw();
    } finally {
      isSyncingNav = false;
    }
  }

  function bindBidirectionalSync(vLeft, vRight) {
    const navSignals = [
      'position',
      'projectionOrientation',
      'projectionScale',
      'projectionDepthRange',
      'crossSectionOrientation',
      'crossSectionScale',
    ];

    for (const prop of navSignals) {
      vLeft[prop].changed.add(() => copyNavigationFromTo(vLeft, vRight));
      vRight[prop].changed.add(() => copyNavigationFromTo(vRight, vLeft));
    }

    const toggleProps = [
      'showPerspectiveSliceViews',
      'showAxisLines',
      'showScaleBar',
      'wireFrame',
    ];
    for (const prop of toggleProps) {
      if (vLeft[prop] && vRight[prop]) {
        vLeft[prop].changed.add(() => {
          if (isSyncingState) return;
          isSyncingState = true;
          vRight[prop].value = vLeft[prop].value;
          isSyncingState = false;
        });
        vRight[prop].changed.add(() => {
          if (isSyncingState) return;
          isSyncingState = true;
          vLeft[prop].value = vRight[prop].value;
          isSyncingState = false;
        });
      }
    }

    bindLayerSync(vLeft, vRight);
  }

  // ============================================================================
  // 6b. Bidirectional Layer & Contrast (ShaderControlState) Synchronization
  // ============================================================================
  let isSyncingLayers = false;

  function syncLayerControls(srcViewer, dstViewer) {
    if (isSyncingLayers || isSyncingState || !srcViewer || !dstViewer) return;
    isSyncingLayers = true;
    try {
      const srcLayers = srcViewer.layerManager.managedLayers;
      const dstLayers = dstViewer.layerManager.managedLayers;

      for (let i = 0; i < srcLayers.length; i++) {
        const srcM = srcLayers[i];
        const dstM = dstLayers.find((l) => l.name === srcM.name) || dstLayers[i];
        if (!srcM || !dstM) continue;

        const srcLayer = srcM.layer;
        const dstLayer = dstM.layer;
        if (!srcLayer || !dstLayer) continue;

        // 1. Sync Shader Controls (Contrast range/window/channel, Color tint, etc.)
        if (srcLayer.shaderControlState && dstLayer.shaderControlState) {
          for (const [key, control] of srcLayer.shaderControlState.state.entries()) {
            const dstControl = dstLayer.shaderControlState.state.get(key);
            if (control?.trackable && dstControl?.trackable) {
              const srcVal = control.trackable.value;
              const dstVal = dstControl.trackable.value;
              const srcJson = JSON.stringify(srcVal);
              const dstJson = JSON.stringify(dstVal);
              if (srcJson !== dstJson) {
                dstControl.trackable.value = JSON.parse(srcJson);
              }
            }
          }
        }

        // 2. Sync Opacity, Volume Gain & Volume Rendering Mode
        if (srcLayer.opacity && dstLayer.opacity && srcLayer.opacity.value !== dstLayer.opacity.value) {
          dstLayer.opacity.value = srcLayer.opacity.value;
        }
        if (
          srcLayer.volumeRenderingGain &&
          dstLayer.volumeRenderingGain &&
          srcLayer.volumeRenderingGain.value !== dstLayer.volumeRenderingGain.value
        ) {
          dstLayer.volumeRenderingGain.value = srcLayer.volumeRenderingGain.value;
        }
        if (
          srcLayer.volumeRenderingMode &&
          dstLayer.volumeRenderingMode &&
          srcLayer.volumeRenderingMode.value !== dstLayer.volumeRenderingMode.value
        ) {
          dstLayer.volumeRenderingMode.value = srcLayer.volumeRenderingMode.value;
        }
        if (
          srcLayer.volumeRenderingDepthSamplesTarget &&
          dstLayer.volumeRenderingDepthSamplesTarget &&
          srcLayer.volumeRenderingDepthSamplesTarget.value !== dstLayer.volumeRenderingDepthSamplesTarget.value
        ) {
          dstLayer.volumeRenderingDepthSamplesTarget.value = srcLayer.volumeRenderingDepthSamplesTarget.value;
        }

        // 3. Sync User-Edited Shader Code
        if (
          srcLayer.fragmentMain &&
          dstLayer.fragmentMain &&
          srcLayer.fragmentMain.value !== dstLayer.fragmentMain.value
        ) {
          dstLayer.fragmentMain.value = srcLayer.fragmentMain.value;
        }

        // 4. Sync Layer Visibility
        if (srcM.visible !== undefined && dstM.visible !== undefined && srcM.visible !== dstM.visible) {
          dstM.visible = srcM.visible;
        }
      }

      dstViewer.display.scheduleRedraw();
    } finally {
      isSyncingLayers = false;
    }
  }

  function bindLayerSync(vLeft, vRight) {
    if (!vLeft || !vRight) return;

    function attachListeners(viewer, otherViewer) {
      for (const m of viewer.layerManager.managedLayers) {
        const layer = m.layer;
        if (!layer) continue;

        if (layer.__vrLayerSyncAttached) continue;
        layer.__vrLayerSyncAttached = true;

        if (layer.shaderControlState) {
          layer.shaderControlState.changed.add(() => {
            syncLayerControls(viewer, otherViewer);
          });
        }
        if (layer.opacity) {
          layer.opacity.changed.add(() => syncLayerControls(viewer, otherViewer));
        }
        if (layer.volumeRenderingGain) {
          layer.volumeRenderingGain.changed.add(() => syncLayerControls(viewer, otherViewer));
        }
        if (layer.fragmentMain) {
          layer.fragmentMain.changed.add(() => syncLayerControls(viewer, otherViewer));
        }
        if (m.visibilityChanged) {
          m.visibilityChanged.add(() => syncLayerControls(viewer, otherViewer));
        }
      }
    }

    attachListeners(vLeft, vRight);
    attachListeners(vRight, vLeft);

    if (!vLeft.layerManager.__vrSyncAttached) {
      vLeft.layerManager.__vrSyncAttached = true;
      vLeft.layerManager.layersChanged.add(() => {
        attachListeners(vLeft, vRight);
      });
    }
    if (!vRight.layerManager.__vrSyncAttached) {
      vRight.layerManager.__vrSyncAttached = true;
      vRight.layerManager.layersChanged.add(() => {
        attachListeners(vRight, vLeft);
      });
    }
  }

  // ============================================================================
  // 7. Synchronized Dual-Eye Stereo Cursor & Hotkey Forwarding
  // ============================================================================
  function setupStereoCursorAndEvents(iframeEl) {
    const win = iframeEl.contentWindow;
    const doc = iframeEl.contentDocument;
    if (!win || !doc) return;

    function updateReticle(clientX, clientY) {
      if (clientX === undefined || clientY === undefined) return;
      const w = win.innerWidth || 1;
      const h = win.innerHeight || 1;
      const xPct = (clientX / w) * 100;
      const yPct = (clientY / h) * 100;
      reticleLeft.style.left = `${xPct}%`;
      reticleLeft.style.top = `${yPct}%`;
      reticleRight.style.left = `${xPct}%`;
      reticleRight.style.top = `${yPct}%`;
      reticleLeft.classList.add('visible');
      reticleRight.classList.add('visible');
    }

    function hideReticle() {
      reticleLeft.classList.remove('visible');
      reticleRight.classList.remove('visible');
    }

    doc.addEventListener(
      'mousemove',
      (e) => updateReticle(e.clientX, e.clientY),
      { passive: true }
    );

    doc.addEventListener(
      'pointermove',
      (e) => updateReticle(e.clientX, e.clientY),
      { passive: true }
    );

    doc.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches?.[0]) updateReticle(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );

    doc.addEventListener('mouseleave', hideReticle, { passive: true });
    doc.addEventListener('pointerup', hideReticle, { passive: true });
    doc.addEventListener('touchend', hideReticle, { passive: true });

    win.addEventListener(
      'keydown',
      (e) => {
        handleGlobalHotkeys(e);
      },
      true
    );
  }

  // ============================================================================
  // 8. State & Custom URL / Neuroglancer Link Loader
  // ============================================================================
  function adaptShaderFor3dVolume(shaderCode, hexColor) {
    const fallbackHex = hexColor || '#ffdca3';
    if (!shaderCode || typeof shaderCode !== 'string') {
      return `#uicontrol invlerp contrast
#uicontrol vec3 color color(default="${fallbackHex}")
void main() {
  float v = contrast();
  if (VOLUME_RENDERING) {
    emitRGBA(vec4(color * v, clamp(v * v * 0.35, 0.0, 1.0)));
  } else {
    emitRGB(color * v);
  }
}`;
    }

    // If shader already handles volume rendering or emitRGBA, keep untouched!
    if (shaderCode.includes('VOLUME_RENDERING') || shaderCode.includes('emitRGBA')) {
      return shaderCode;
    }

    // Detect invlerp control name if present (e.g. contrast, normalized, intensity)
    const invlerpMatch = shaderCode.match(/#uicontrol\s+invlerp\s+([a-zA-Z0-9_]+)/);
    const invlerpName = invlerpMatch ? invlerpMatch[1] : null;

    // Check if there is already a #uicontrol vec3 color
    const hasColorControl = /#uicontrol\s+vec3\s+color\b/.test(shaderCode);
    let prefix = '';
    if (!hasColorControl) {
      prefix = `#uicontrol vec3 color color(default="${fallbackHex}")\n`;
    }

    const mainRegex = /void\s+main\s*\(\s*\)\s*\{([^}]*)\}/;
    const mainMatch = shaderCode.match(mainRegex);
    if (!mainMatch) {
      return prefix + shaderCode;
    }

    const originalBody = mainMatch[1].trim();

    let newMain;
    if (invlerpName) {
      newMain = `void main() {
  float v = ${invlerpName}();
  if (VOLUME_RENDERING) {
    emitRGBA(vec4(color * v, clamp(v * v * 0.35, 0.0, 1.0)));
  } else {
    ${originalBody}
  }
}`;
    } else {
      newMain = `void main() {
  if (VOLUME_RENDERING) {
    float v = toNormalized(getDataValue());
    emitRGBA(vec4(color * v, clamp(v * v * 0.35, 0.0, 1.0)));
  } else {
    ${originalBody}
  }
}`;
    }

    return prefix + shaderCode.replace(mainRegex, newMain);
  }

  function normalizeStateFor3D(stateObj) {
    if (!stateObj || typeof stateObj !== 'object') return null;

    const hex = COLORMAPS[stereoState.colormap] || COLORMAPS.amber;
    const volMode =
      stereoState.renderMode === 'slices_only'
        ? 'off'
        : stereoState.renderMode === 'mip_only'
        ? 'max'
        : 'on';
    const showSlices =
      stereoState.renderMode === 'volume_and_slices' ||
      stereoState.renderMode === 'slices_only';

    const normalized = { ...stateObj };

    // 1. Force 3D layout while keeping cross-sections spec if available
    normalized.layout = buildLayoutSpec(stereoState.renderMode);
    normalized.showSlices = showSlices;
    normalized.hideCrossSectionBackground3D = true;
    normalized.showAxisLines = false;
    normalized.showScaleBar = false;
    normalized.perspectiveViewBackgroundColor = '#05070b';

    // 2. Normalize orientation & scale naming (legacy perspectiveOrientation / perspectiveZoom)
    if (normalized.perspectiveOrientation && !normalized.projectionOrientation) {
      normalized.projectionOrientation = normalized.perspectiveOrientation;
    }
    if (normalized.perspectiveZoom && !normalized.projectionScale) {
      normalized.projectionScale = normalized.perspectiveZoom;
    }

    // 3. Process and upgrade layers for 3D stereoscopic viewing
    if (Array.isArray(normalized.layers)) {
      let firstImageLayer = true;
      normalized.layers = normalized.layers.map((layer) => {
        if (layer.type === 'image') {
          const upgraded = { ...layer };

          // Automatically enable 3D volume rendering if off or unspecified
          if (!upgraded.volumeRendering || upgraded.volumeRendering === 'off') {
            upgraded.volumeRendering = volMode;
          }
          if (upgraded.volumeRenderingGain === undefined) {
            upgraded.volumeRenderingGain = stereoState.volumeGain;
          } else if (firstImageLayer) {
            // Adopt the dataset's existing gain in HUD
            stereoState.volumeGain = upgraded.volumeRenderingGain;
            sliderGain.value = String(stereoState.volumeGain);
            valGain.textContent = stereoState.volumeGain.toFixed(1);
          }

          if (!upgraded.volumeRenderingDepthSamples) {
            upgraded.volumeRenderingDepthSamples = 192;
          }

          // Adapt shader for translucent 3D volume rendering while preserving user's contrast ranges
          upgraded.shader = adaptShaderFor3dVolume(upgraded.shader, hex);

          firstImageLayer = false;
          return upgraded;
        }

        // Preserve all non-image layers (e.g. annotation bounding boxes, ROIs, segmentations)
        return layer;
      });
    }

    // 4. Derive fallback position from annotations / bounding boxes if position is missing
    if (!normalized.position && Array.isArray(normalized.layers)) {
      for (const layer of normalized.layers) {
        if (layer.type === 'annotation' && Array.isArray(layer.annotations)) {
          for (const ann of layer.annotations) {
            if (ann.point && Array.isArray(ann.point)) {
              normalized.position = ann.point.slice();
              break;
            } else if (ann.pointA && ann.pointB) {
              normalized.position = [
                (ann.pointA[0] + ann.pointB[0]) / 2,
                (ann.pointA[1] + ann.pointB[1]) / 2,
                (ann.pointA[2] + ann.pointB[2]) / 2,
              ];
              break;
            }
          }
        }
        if (normalized.position) break;
      }
    }

    return normalized;
  }

  function applyStateToBothViewers(stateObj) {
    if (!leftViewer || !rightViewer || !stateObj) return;
    isSyncingNav = true;
    isSyncingState = true;
    try {
      const normalized = normalizeStateFor3D(stateObj);

      leftViewer.state.reset();
      rightViewer.state.reset();
      leftViewer.state.restoreState(normalized);
      rightViewer.state.restoreState(JSON.parse(JSON.stringify(normalized)));

      if (Number.isFinite(normalized.projectionScale) && normalized.projectionScale > 0) {
        stereoState.referenceScale = normalized.projectionScale;
      } else {
        stereoState.referenceScale = 0; // Will auto-capture on first valid projectionScale
      }

      leftViewer.uiConfiguration.showPanelBorders.value = false;
      rightViewer.uiConfiguration.showPanelBorders.value = false;
      updateNgUiVisibility(stereoState.showNgUi);
    } finally {
      isSyncingNav = false;
      isSyncingState = false;
    }
    bindLayerSync(leftViewer, rightViewer);
    refreshStereoProjection();
  }

  function loadPreset(presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return;
    stereoState.activePreset = presetKey;
    stereoState.volumeGain = preset.defaultGain;
    sliderGain.value = String(preset.defaultGain);
    valGain.textContent = preset.defaultGain.toFixed(1);

    presetEscargotBtn.classList.toggle('active', presetKey === 'escargot');
    presetHipctBtn.classList.toggle('active', presetKey === 'hipct');
    if (presetHeartBtn) presetHeartBtn.classList.toggle('active', presetKey === 'heart');
    customSourceInput.value = preset.url;

    const stateObj = preset.buildState(
      stereoState.colormap,
      stereoState.renderMode,
      stereoState.volumeGain
    );
    applyStateToBothViewers(stateObj);
    stereoState.cuboidLimit.center = null;
    if (stereoState.cuboidLimit.enabled) {
      applyCuboidLimit(false);
    }
    showStereoToast(`Loaded: ${preset.label}`);
  }

  async function resolveStateFromInput(rawInput) {
    const input = (rawInput || '').trim();
    if (!input) return null;

    // 1. Known Presets
    if (input.replace(/\/+$/, '') === PRESETS.escargot.url.replace(/\/+$/, '')) {
      loadPreset('escargot');
      return null;
    }
    if (input.replace(/\/+$/, '') === PRESETS.hipct.url.replace(/\/+$/, '')) {
      loadPreset('hipct');
      return null;
    }
    if (input.replace(/\/+$/, '') === PRESETS.heart.url.replace(/\/+$/, '')) {
      loadPreset('heart');
      return null;
    }

    // 2. Direct JSON State String: {"dimensions":...}
    if (input.startsWith('{')) {
      return JSON.parse(input);
    }

    // 3. Neuroglancer URL containing fragment #!
    const hashIdx = input.indexOf('#!');
    if (hashIdx !== -1) {
      let fragment = input.slice(hashIdx + 2).trim();
      if (
        fragment.startsWith('%7B') ||
        fragment.startsWith('%7b') ||
        fragment.startsWith('%22') ||
        fragment.includes('%22')
      ) {
        try {
          fragment = decodeURIComponent(fragment);
        } catch (e) {
          // Keep raw fragment if decodeURIComponent fails
        }
      }

      if (fragment.startsWith('{')) {
        return JSON.parse(fragment);
      }

      // Fragment might point to a JSON state URL: #!gs://... or #!https://...
      if (
        fragment.startsWith('gs://') ||
        fragment.startsWith('http://') ||
        fragment.startsWith('https://')
      ) {
        let fetchUrl = fragment;
        if (fetchUrl.startsWith('gs://')) {
          fetchUrl = fetchUrl.replace(/^gs:\/\//, 'https://storage.googleapis.com/');
        }
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching state JSON`);
        return await resp.json();
      }
    }

    // 4. URL with ?json_url= parameter
    try {
      const urlObj = new URL(input);
      const jsonUrl = urlObj.searchParams.get('json_url');
      if (jsonUrl) {
        let fetchUrl = jsonUrl;
        if (fetchUrl.startsWith('gs://')) {
          fetchUrl = fetchUrl.replace(/^gs:\/\//, 'https://storage.googleapis.com/');
        }
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching json_url`);
        return await resp.json();
      }
    } catch (e) {
      // Not a standard URL object, proceed
    }

    // 5. Direct URL to a .json state file
    if (input.endsWith('.json')) {
      let fetchUrl = input;
      if (fetchUrl.startsWith('gs://')) {
        fetchUrl = fetchUrl.replace(/^gs:\/\//, 'https://storage.googleapis.com/');
      }
      const resp = await fetch(fetchUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching state file`);
      return await resp.json();
    }

    // 6. Raw dataset URL (e.g. gs://.../data.zarr or https://.../data.zarr or precomputed://...)
    let sourceUrl = input;
    const hasProviderPrefix = /^[a-z0-9_+]+:\/\/[a-z0-9_+]+:\/\//i.test(sourceUrl);
    if (!hasProviderPrefix) {
      if (
        sourceUrl.includes('.zarr') ||
        sourceUrl.startsWith('https://') ||
        sourceUrl.startsWith('http://') ||
        sourceUrl.startsWith('gs://') ||
        sourceUrl.startsWith('s3://')
      ) {
        sourceUrl = `zarr://${sourceUrl}`;
      }
    }

    const hex = COLORMAPS[stereoState.colormap] || COLORMAPS.amber;
    const volMode =
      stereoState.renderMode === 'slices_only'
        ? 'off'
        : stereoState.renderMode === 'mip_only'
        ? 'max'
        : 'on';
    const showSlices =
      stereoState.renderMode === 'volume_and_slices' ||
      stereoState.renderMode === 'slices_only';

    return {
      showSlices: showSlices,
      hideCrossSectionBackground3D: true,
      showAxisLines: false,
      showScaleBar: false,
      perspectiveViewBackgroundColor: '#05070b',
      layout: buildLayoutSpec(stereoState.renderMode),
      layers: [
        {
          type: 'image',
          name: 'custom_volume',
          source: sourceUrl,
          volumeRendering: volMode,
          volumeRenderingGain: stereoState.volumeGain,
          volumeRenderingDepthSamples: 192,
          shader: `#uicontrol invlerp contrast
#uicontrol vec3 color color(default="${hex}")
void main() {
  float v = contrast();
  if (VOLUME_RENDERING) {
    emitRGBA(vec4(color * v, clamp(v * v * 0.35, 0.0, 1.0)));
  } else {
    emitRGB(color * v);
  }
}`,
        },
      ],
    };
  }

  async function parseAndLoadCustomInput(rawInput) {
    const input = (rawInput || '').trim();
    if (!input) return;

    stereoState.activePreset = null;
    presetEscargotBtn.classList.remove('active');
    presetHipctBtn.classList.remove('active');
    if (presetHeartBtn) presetHeartBtn.classList.remove('active');

    try {
      showStereoToast('Loading Neuroglancer state…');
      const rawState = await resolveStateFromInput(input);
      if (!rawState) return;

      applyStateToBothViewers(rawState);

      const layerCount = Array.isArray(rawState.layers) ? rawState.layers.length : 1;
      const hasAnnotations = Array.isArray(rawState.layers) && rawState.layers.some((l) => l.type === 'annotation');
      const annLabel = hasAnnotations ? ' + Bounding Boxes' : '';
      showStereoToast(`Loaded: ${layerCount} Layer(s)${annLabel} in 3D Stereo`);
    } catch (err) {
      console.error('Failed to parse custom source/link:', err);
      showStereoToast(`Error loading state: ${err.message || 'Invalid link'}`);
    }
  }

  // ============================================================================
  // 9. Live In-Place Layer Rendering Updates (Zero Reset, Zero Zoom Drift!)
  // ============================================================================
  function updateLiveRenderingControls() {
    if (!leftViewer || !rightViewer) return;

    const showSlices =
      stereoState.renderMode === 'volume_and_slices' ||
      stereoState.renderMode === 'slices_only';
    const volModeEnum = VOLUME_MODE_ENUM[stereoState.renderMode] ?? 1;

    isSyncingNav = true;
    isSyncingState = true;
    try {
      for (const viewer of [leftViewer, rightViewer]) {
        viewer.showPerspectiveSliceViews.value = showSlices;
        viewer.hideCrossSectionBackground3D.value = true;

        // Toggle 3D crossSections in-place without resetting layers or zoom scale
        const crossSections = viewer.layout?.specification?.crossSections;
        if (crossSections) {
          if (showSlices && crossSections.size === 0) {
            crossSections.restoreState(CROSS_SECTIONS_SPEC);
          } else if (!showSlices && crossSections.size > 0) {
            crossSections.clear();
          }
        }

        for (const managedLayer of viewer.layerManager.managedLayers) {
          const userLayer = managedLayer.layer;
          if (!userLayer || userLayer.type !== 'image') continue;

          if (userLayer.volumeRenderingMode) {
            userLayer.volumeRenderingMode.value = volModeEnum;
          }
          if (userLayer.volumeRenderingGain) {
            userLayer.volumeRenderingGain.value = stereoState.volumeGain;
          }
          if (userLayer.volumeRenderingDepthSamplesTarget) {
            userLayer.volumeRenderingDepthSamplesTarget.value = stereoState.depthSamples;
          }

          if (
            stereoState.activePreset &&
            PRESETS[stereoState.activePreset] &&
            userLayer.fragmentMain
          ) {
            const range = PRESETS[stereoState.activePreset].range;
            userLayer.fragmentMain.value = buildVolumeShader(
              range[0],
              range[1],
              COLORMAPS[stereoState.colormap]
            );
          }
        }
        viewer.display.scheduleRedraw();
      }
    } finally {
      isSyncingNav = false;
      isSyncingState = false;
    }
  }

  function updateNgUiVisibility(showUi) {
    stereoState.showNgUi = showUi;
    btnNgUi.classList.toggle('active', showUi);
    for (const iframeEl of [iframeLeft, iframeRight]) {
      const doc = iframeEl.contentDocument;
      if (doc && doc.body) {
        doc.body.classList.toggle('vr-clean-ui', !showUi);
      }
    }
    if (leftViewer && rightViewer) {
      for (const v of [leftViewer, rightViewer]) {
        v.uiConfiguration.showUIControls.value = showUi;
        if (v.uiConfiguration.showTopBar) v.uiConfiguration.showTopBar.value = showUi;
        if (v.uiConfiguration.showLayerPanel) v.uiConfiguration.showLayerPanel.value = showUi;
      }
    }
  }

  // ============================================================================
  // 10. Auto-Orbit & Media Session Controls (Quest SBS Playback Bar)
  // ============================================================================
  function rotateVolumeDegrees(degrees) {
    if (!leftViewer) return;
    const rad = (degrees * Math.PI) / 180;
    const half = rad * 0.5;
    const ry = Math.sin(half);
    const rw = Math.cos(half);

    const q = leftViewer.projectionOrientation.orientation;
    const q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
    q[0] = q0 * rw - q2 * ry;
    q[1] = q1 * rw + q3 * ry;
    q[2] = q2 * rw + q0 * ry;
    q[3] = q3 * rw - q1 * ry;

    leftViewer.projectionOrientation.changed.dispatch();
    leftViewer.display?.scheduleRedraw();
    rightViewer?.display?.scheduleRedraw();
  }

  let lastOrbitTime = performance.now();
  let currentRotationAngle = 0;
  let lastGamepadButtonState = {};

  function orbitAnimationLoop(now) {
    const dt = Math.min(0.1, (now - lastOrbitTime) / 1000);
    lastOrbitTime = now;

    if (stereoState.autoOrbit && leftViewer && rightViewer) {
      const deg = dt * 0.32 * (180 / Math.PI);
      rotateVolumeDegrees(deg);
      currentRotationAngle = (currentRotationAngle + deg) % 360;
    }

    // Quest Touch Controller gamepad polling when in 2D / SBS screen mode
    if (navigator.getGamepads && !xrSession && leftViewer) {
      const gamepads = navigator.getGamepads();
      if (gamepads) {
        for (let i = 0; i < gamepads.length; i++) {
          const gp = gamepads[i];
          if (!gp || !gp.connected) continue;

          // Thumbstick X for rotation
          const stickX =
            Math.abs(gp.axes[2]) > 0.15
              ? gp.axes[2]
              : Math.abs(gp.axes[0]) > 0.15
              ? gp.axes[0]
              : 0;
          if (Math.abs(stickX) > 0.15) {
            const rotDelta = stickX * dt * 75;
            rotateVolumeDegrees(rotDelta);
            currentRotationAngle = (currentRotationAngle + rotDelta + 360) % 360;
          }

          // Thumbstick Y for zoom
          const stickY =
            Math.abs(gp.axes[3]) > 0.15
              ? gp.axes[3]
              : Math.abs(gp.axes[1]) > 0.15
              ? gp.axes[1]
              : 0;
          if (Math.abs(stickY) > 0.18 && leftViewer.projectionScale) {
            const factor = 1.0 + stickY * dt * 2.0;
            leftViewer.projectionScale.value = Math.max(10, leftViewer.projectionScale.value * factor);
            leftViewer.projectionScale.changed.dispatch();
          }

          // Button A (or button 0 / 4) for cycling volume depth resolution
          const btnA = gp.buttons[0]?.pressed || gp.buttons[4]?.pressed;
          const idA = `${i}_A`;
          if (btnA && !lastGamepadButtonState[idA]) {
            cycleResolutionSamples();
          }
          lastGamepadButtonState[idA] = !!btnA;

          // Button B (or button 1 / 5) for toggling Zoom-relative
          const btnB = gp.buttons[1]?.pressed || gp.buttons[5]?.pressed;
          const idB = `${i}_B`;
          if (btnB && !lastGamepadButtonState[idB]) {
            toggleZoomRelative();
          }
          lastGamepadButtonState[idB] = !!btnB;
        }
      }
    }

    requestAnimationFrame(orbitAnimationLoop);
  }
  requestAnimationFrame(orbitAnimationLoop);

  // ============================================================================
  // 10b. Meta Quest Media Session & SBS Playback Bar Integration
  // ============================================================================
  let mediaSessionAudio = null;

  function updateMediaSessionState() {
    if (!('mediaSession' in navigator)) return;
    try {
      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: 360,
          playbackRate: stereoState.autoOrbit ? 1.0 : 0.0,
          position: Math.max(0, Math.min(360, currentRotationAngle)),
        });
      }
    } catch (_) {}
  }

  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    // Silent looping audio to keep MediaSession active in Quest Horizon OS media player
    if (!mediaSessionAudio) {
      const silentWav =
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      mediaSessionAudio = new Audio(silentWav);
      mediaSessionAudio.loop = true;
      mediaSessionAudio.volume = 0.01;
    }

    const startAudio = () => {
      if (mediaSessionAudio && mediaSessionAudio.paused) {
        mediaSessionAudio.play().catch(() => {});
      }
    };
    window.addEventListener('click', startAudio, { once: true });
    window.addEventListener('touchstart', startAudio, { once: true });
    window.addEventListener('pointerdown', startAudio, { once: true });

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Neuroglancer 3D Volume',
        artist: 'VRZarr (Quest SBS Mode)',
        album: '⏪ -10s / ⏩ +10s rotates view ±10° | ▶/⏸ Auto-Orbit',
      });
    } catch (_) {}

    navigator.mediaSession.playbackState = stereoState.autoOrbit ? 'playing' : 'paused';

    // -10 sec button: Rotate view -10 degrees (Yaw Left)
    try {
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const deg = details?.seekOffset || 10;
        rotateVolumeDegrees(-deg);
        currentRotationAngle = (currentRotationAngle - deg + 360) % 360;
        updateMediaSessionState();
        showStereoToast(`↺ Rotated -${deg}° (Quest -10s)`);
      });
    } catch (_) {}

    // +10 sec button: Rotate view +10 degrees (Yaw Right)
    try {
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const deg = details?.seekOffset || 10;
        rotateVolumeDegrees(deg);
        currentRotationAngle = (currentRotationAngle + deg) % 360;
        updateMediaSessionState();
        showStereoToast(`↻ Rotated +${deg}° (Quest +10s)`);
      });
    } catch (_) {}

    // Play button: Start Auto-Orbit
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        stereoState.autoOrbit = true;
        if (mediaSessionAudio && mediaSessionAudio.paused) {
          mediaSessionAudio.play().catch(() => {});
        }
        navigator.mediaSession.playbackState = 'playing';
        if (btnAutoOrbit) btnAutoOrbit.classList.add('active');
        showStereoToast('▶ Auto-Orbit Started (Quest Play)');
        updateMediaSessionState();
      });
    } catch (_) {}

    // Pause button: Stop Auto-Orbit
    try {
      navigator.mediaSession.setActionHandler('pause', () => {
        stereoState.autoOrbit = false;
        navigator.mediaSession.playbackState = 'paused';
        if (btnAutoOrbit) btnAutoOrbit.classList.remove('active');
        showStereoToast('⏸ Auto-Orbit Paused (Quest Pause)');
        updateMediaSessionState();
      });
    } catch (_) {}

    // Timeline Scrubbing: Map 0-360 seconds directly to 0°-360° rotation angle
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details?.seekTime !== undefined) {
          const targetDeg = details.seekTime % 360;
          const delta = targetDeg - currentRotationAngle;
          rotateVolumeDegrees(delta);
          currentRotationAngle = targetDeg;
          updateMediaSessionState();
          showStereoToast(`🎯 Rotated to ${Math.round(targetDeg)}°`);
        }
      });
    } catch (_) {}

    // Next Track: Cycle resolution depth samples
    try {
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        cycleResolutionSamples();
      });
    } catch (_) {}

    // Previous Track: Toggle 3D Cuboid Limit
    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        toggleCuboidLimit();
      });
    } catch (_) {}

    updateMediaSessionState();
  }

  // ============================================================================
  // 11. UI Event Listeners & VR Hotkeys
  // ============================================================================
  function setSeparation(val) {
    const clamped = Math.max(0, Math.min(15, Math.round(val * 4) / 4));
    stereoState.separationPercent = clamped;
    sliderSeparation.value = String(clamped);
    valSeparation.textContent = `${clamped.toFixed(2)}%`;
    refreshStereoProjection();
  }

  function setConvergence(val) {
    const clamped = Math.max(0, Math.min(150, Math.round(val)));
    stereoState.convergencePercent = clamped;
    sliderConvergence.value = String(clamped);
    valConvergence.textContent = `${clamped}%`;
    refreshStereoProjection();
  }

  function setPerspectiveFov(val) {
    const clamped = Math.max(30, Math.min(120, Math.round(val)));
    stereoState.perspectiveFovDeg = clamped;
    if (sliderPerspective) sliderPerspective.value = String(clamped);
    refreshStereoProjection();
  }

  function setAutoDolly(val) {
    const clamped = Math.max(0, Math.min(100, Math.round(val / 5) * 5));
    stereoState.autoDollyPercent = clamped;
    if (sliderDolly) sliderDolly.value = String(clamped);
    refreshStereoProjection();
  }

  function setAspectCorrection(val) {
    const clamped = Math.max(0.4, Math.min(3.0, parseFloat(val) || 1.0));
    stereoState.aspectCorrection = clamped;
    if (sliderAspect) sliderAspect.value = String(clamped);
    if (valAspect) {
      if (Math.abs(clamped - 2.0) < 0.05) {
        valAspect.textContent = '2.00x (Quest Fix)';
      } else if (Math.abs(clamped - 1.0) < 0.05) {
        valAspect.textContent = '1.00x (Normal)';
      } else {
        valAspect.textContent = `${clamped.toFixed(2)}x`;
      }
    }
    btnToggleAspect?.classList.toggle('active', Math.abs(clamped - 2.0) < 0.05);
    btnAspectFix?.classList.toggle('active', Math.abs(clamped - 2.0) < 0.05);
    refreshStereoProjection();
  }

  function toggleAspectCorrection() {
    if (Math.abs(stereoState.aspectCorrection - 2.0) < 0.05) {
      setAspectCorrection(1.0);
      showStereoToast('Aspect: 1.0x Normal (1:1 Native)');
    } else {
      setAspectCorrection(2.0);
      showStereoToast('Aspect: 2.0x Quest SBS Fix (Compensates 2:1 Stretch)');
    }
  }

  // ============================================================================
  // 9b. 3D Cuboid Subvolume Limit (Quest Mobile Processor Optimization)
  // ============================================================================
  function getDatasetCenterFallback() {
    if (leftViewer?.navigationState?.pose?.position?.value) {
      return Array.from(leftViewer.navigationState.pose.position.value);
    }
    return [500, 500, 350];
  }

  function updateCuboidAnnotation(viewer, min, max, visible) {
    if (!viewer?.layerSpecification) return;
    try {
      const curLayers = viewer.layerSpecification.toJSON();
      const filtered = curLayers.filter((l) => l.name !== '3D_Cuboid_Limit');
      if (visible && min && max) {
        filtered.push({
          type: 'annotation',
          name: '3D_Cuboid_Limit',
          annotations: [
            {
              type: 'axis_aligned_bounding_box',
              id: 'cuboid_box',
              pointA: [min[0], min[1], min[2]],
              pointB: [max[0], max[1], max[2]],
            },
          ],
          annotationColor: '#00e5ff',
        });
      }
      viewer.layerSpecification.restoreState(filtered);
    } catch (e) {
      console.warn('Could not update cuboid annotation layer:', e);
    }
  }

  function applyCuboidLimit(showToastMsg = true) {
    const enabled = stereoState.cuboidLimit.enabled;
    const size = stereoState.cuboidLimit.size;
    let center = stereoState.cuboidLimit.center;
    if (!center) {
      center = getDatasetCenterFallback();
      stereoState.cuboidLimit.center = center;
    }

    const half = size / 2;
    const min = [
      Math.round(center[0] - half),
      Math.round(center[1] - half),
      Math.round(center[2] - half),
    ];
    const max = [
      Math.round(center[0] + half),
      Math.round(center[1] + half),
      Math.round(center[2] + half),
    ];

    const limitObj = {
      enabled: enabled,
      size: size,
      min: min,
      max: max,
    };

    if (iframeLeft?.contentWindow) iframeLeft.contentWindow.vrCuboidLimit = limitObj;
    if (iframeRight?.contentWindow) iframeRight.contentWindow.vrCuboidLimit = limitObj;

    // Update UI elements
    if (btnCuboidLimit) {
      btnCuboidLimit.textContent = enabled ? '📦 Cuboid: ON' : '📦 Cuboid: OFF';
      btnCuboidLimit.classList.toggle('active', enabled);
    }
    if (btnToggleCuboid) {
      btnToggleCuboid.textContent = enabled ? 'Disable Cuboid' : '📦 Enable Cuboid';
      btnToggleCuboid.classList.toggle('active', enabled);
    }
    if (valCuboid) {
      valCuboid.textContent = enabled ? `${size}³ voxels` : 'OFF (Full)';
    }
    if (selectCuboidSize) {
      selectCuboidSize.value = String(size);
    }
    if (btnCuboidCage) {
      btnCuboidCage.classList.toggle('active', stereoState.cuboidLimit.showCage);
    }

    // Update 3D wireframe bounding cage in both eyes
    const showCage = enabled && stereoState.cuboidLimit.showCage;
    if (leftViewer) updateCuboidAnnotation(leftViewer, min, max, showCage);
    if (rightViewer) updateCuboidAnnotation(rightViewer, min, max, showCage);

    // Force redraw & chunk requery
    leftViewer?.display?.scheduleRedraw();
    rightViewer?.display?.scheduleRedraw();

    if (showToastMsg) {
      showStereoToast(
        enabled
          ? `📦 3D Cuboid Limit: ON (${size}³ voxels — Quest Optimized)`
          : '📦 3D Cuboid Limit: OFF (Full Volume)'
      );
    }
  }

  function toggleCuboidLimit() {
    stereoState.cuboidLimit.enabled = !stereoState.cuboidLimit.enabled;
    if (stereoState.cuboidLimit.enabled && !stereoState.cuboidLimit.center) {
      stereoState.cuboidLimit.center = getDatasetCenterFallback();
    }
    applyCuboidLimit(true);
  }

  function centerCuboidOnView() {
    stereoState.cuboidLimit.center = getDatasetCenterFallback();
    if (!stereoState.cuboidLimit.enabled) {
      stereoState.cuboidLimit.enabled = true;
    }
    applyCuboidLimit(false);
    const c = stereoState.cuboidLimit.center.map((v) => Math.round(v));
    showStereoToast(`📦 Cuboid Centered on [${c.join(', ')}] (${stereoState.cuboidLimit.size}³)`);
  }

  function setCuboidSize(sizeVal) {
    const parsed = parseInt(sizeVal, 10) || 512;
    stereoState.cuboidLimit.size = parsed;
    applyCuboidLimit(stereoState.cuboidLimit.enabled);
  }

  function toggleCuboidCage() {
    stereoState.cuboidLimit.showCage = !stereoState.cuboidLimit.showCage;
    applyCuboidLimit(false);
    showStereoToast(
      stereoState.cuboidLimit.showCage ? 'Cuboid 3D Cage: Visible' : 'Cuboid 3D Cage: Hidden'
    );
  }

  // ============================================================================
  // 10. Zoom-Relative Depth Mode & 3D Resolution Sampling Controls
  // ============================================================================
  function toggleZoomRelative(forceVal) {
    const nextVal = typeof forceVal === 'boolean' ? forceVal : !stereoState.zoomRelative;
    stereoState.zoomRelative = nextVal;

    for (const v of [leftViewer, rightViewer]) {
      if (!v?.projectionDepthRange) continue;
      const current = v.projectionDepthRange.value;
      // In 3D perspective views, the zoom factor is perspectiveNavigationState.zoomFactor
      // (or projectionScale), NOT navigationState.zoomFactor (which is for 2D slice views)
      const zoom =
        v.perspectiveNavigationState?.zoomFactor?.value ??
        v.projectionScale?.value ??
        1.0;

      if (nextVal) {
        // Switching to Zoom-relative (negative depth range value in Neuroglancer)
        // Maintains the EXACT same effective relativeDepthRange so zoom/resolution do not jump
        if (current > 0) {
          v.projectionDepthRange.value = -current / zoom;
        } else if (current === 0 || !Number.isFinite(current)) {
          v.projectionDepthRange.value = -50;
        }
      } else {
        // Switching to Fixed absolute depth range (positive depth range value in Neuroglancer)
        // Maintains the EXACT same effective relativeDepthRange so zoom/resolution do not jump
        if (current < 0) {
          v.projectionDepthRange.value = -current * zoom;
        } else if (current === 0 || !Number.isFinite(current)) {
          v.projectionDepthRange.value = 50 * zoom;
        }
      }
      v.display.scheduleRedraw();
    }

    if (btnToggleZoomRelative) {
      btnToggleZoomRelative.classList.toggle('active', stereoState.zoomRelative);
    }
    if (valZoomRelative) {
      valZoomRelative.textContent = stereoState.zoomRelative ? 'ON (Relative)' : 'OFF (Fixed)';
    }
    if (typeof forceVal !== 'boolean') {
      showStereoToast(
        stereoState.zoomRelative
          ? 'Zoom-Relative: ON (Depth scales with zoom)'
          : 'Zoom-Relative: OFF (Fixed depth)'
      );
    }
  }

  function setDepthSamples(sampleCount) {
    const samples = parseInt(sampleCount, 10);
    if (!Number.isFinite(samples) || samples <= 0) return;
    stereoState.depthSamples = samples;

    for (const v of [leftViewer, rightViewer]) {
      if (!v) continue;
      for (const m of v.layerManager.managedLayers) {
        const layer = m.layer;
        if (layer?.volumeRenderingDepthSamplesTarget) {
          layer.volumeRenderingDepthSamplesTarget.value = samples;
        }
      }
      v.display.scheduleRedraw();
    }

    if (selectDepthSamples) {
      selectDepthSamples.value = String(samples);
    }
    if (valDepthSamples) {
      valDepthSamples.textContent = `${samples} Samples`;
    }
    showStereoToast(`3D Raycast Resolution: ${samples} Samples`);
  }

  const RESOLUTION_LEVELS = [128, 192, 256, 384, 512, 768, 1024];
  function cycleResolutionSamples() {
    const curr = stereoState.depthSamples;
    let idx = RESOLUTION_LEVELS.indexOf(curr);
    if (idx === -1) {
      idx = 0;
      for (let i = 0; i < RESOLUTION_LEVELS.length; i++) {
        if (RESOLUTION_LEVELS[i] >= curr) {
          idx = i;
          break;
        }
      }
    }
    const nextIdx = (idx + 1) % RESOLUTION_LEVELS.length;
    setDepthSamples(RESOLUTION_LEVELS[nextIdx]);
  }

  function resetCamera() {
    if (stereoState.activePreset && PRESETS[stereoState.activePreset]) {
      loadPreset(stereoState.activePreset);
    } else if (leftViewer) {
      leftViewer.projectionOrientation?.reset?.();
      leftViewer.projectionScale?.reset?.();
    }
    showStereoToast('Reset 3D Camera Pose');
  }

  // ============================================================================
  // 11. WebXR Immersive 6DoF Stereoscopic VR Engine (Meta Quest 2 & Headsets)
  // ============================================================================
  let xrSession = null;
  let xrRefSpace = null;
  let xrGl = null;
  let xrLayer = null;
  let xrProgram = null;
  let xrVAO = null;
  let xrIndexCount = 0;
  let xrTexLeft = null;
  let xrTexRight = null;
  let xrLastGrabPos = { left: null, right: null };
  let xrButtonDebounce = { a: false, b: false, x: false, y: false };

  function initWebXR() {
    if (!navigator.xr) return;
    navigator.xr
      .isSessionSupported('immersive-vr')
      .then((supported) => {
        if (supported && btnEnterWebXR) {
          btnEnterWebXR.style.display = '';
          btnEnterWebXR.addEventListener('click', () => {
            if (xrSession) {
              xrSession.end();
            } else {
              startWebXRSession();
            }
          });
          showStereoToast('Quest 2 Ready: Click "Enter VR" for 6DoF immersion!');
        }
      })
      .catch((err) => {
        console.warn('WebXR check error:', err);
      });
  }

  async function startWebXRSession() {
    if (!navigator.xr || xrSession) return;
    try {
      showStereoToast('Starting Quest 2 Immersive VR…');
      const session = await navigator.xr.requestSession('immersive-vr', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['bounded-floor', 'hand-tracking'],
      });
      xrSession = session;

      const xrCanvas = document.createElement('canvas');
      const gl = xrCanvas.getContext('webgl2', { xrCompatible: true });
      if (!gl) {
        throw new Error('WebGL2 with XR compatibility not supported');
      }
      await gl.makeXRCompatible();
      xrGl = gl;

      xrLayer = new XRWebGLLayer(session, gl);
      session.updateRenderState({ baseLayer: xrLayer });
      xrRefSpace = await session.requestReferenceSpace('local-floor');

      initXRShadersAndGeometry(gl);
      initXRTextures(gl);

      session.addEventListener('end', onXRSessionEnded);
      session.requestAnimationFrame(onXRFrame);

      if (btnEnterWebXR) {
        btnEnterWebXR.textContent = '❌ Exit VR';
        btnEnterWebXR.classList.add('active');
      }
      showStereoToast('VR Active: Grip=Rotate, Stick=Zoom, A=Res, B=Zoom-Rel');
    } catch (err) {
      console.error('WebXR session start failed:', err);
      showStereoToast(`WebXR Error: ${err.message || 'Could not start VR'}`);
    }
  }

  function onXRSessionEnded() {
    xrSession = null;
    if (btnEnterWebXR) {
      btnEnterWebXR.textContent = '🥽 Enter VR (Quest 2)';
      btnEnterWebXR.classList.remove('active');
    }
    showStereoToast('Exited VR Session');
  }

  function initXRShadersAndGeometry(gl) {
    const vsSource = `#version 300 es
    in vec3 aPosition;
    in vec2 aTexCoord;
    uniform mat4 uProjectionMatrix;
    uniform mat4 uViewMatrix;
    out vec2 vTexCoord;
    void main() {
      vTexCoord = aTexCoord;
      gl_Position = uProjectionMatrix * uViewMatrix * vec4(aPosition, 1.0);
    }`;

    const fsSource = `#version 300 es
    precision mediump float;
    uniform sampler2D uTexture;
    in vec2 vTexCoord;
    out vec4 fragColor;
    void main() {
      fragColor = texture(uTexture, vTexCoord);
    }`;

    function createShader(gl, type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(s));
      }
      return s;
    }

    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    xrProgram = prog;

    // Curved IMAX-style display cylinder segment in VR space
    const slices = 32;
    const radius = 1.85;
    const lCanvas = iframeLeft?.contentDocument?.querySelector('canvas');
    const canvasAspect = (lCanvas && lCanvas.height > 0) ? (lCanvas.width / lCanvas.height) : 0.888;
    const height = 1.70;
    const targetArc = height * canvasAspect;
    const halfAngle = Math.min(Math.PI * 0.45, targetArc / (2 * radius));
    const yTop = 1.35 + (height / 2);
    const yBottom = 1.35 - (height / 2);

    const vertices = [];
    const indices = [];

    for (let i = 0; i <= slices; i++) {
      const u = i / slices;
      const angle = -halfAngle + 2 * halfAngle * u;
      const x = radius * Math.sin(angle);
      const z = -radius * Math.cos(angle) + (radius - 1.45);

      vertices.push(x, yTop, z, u, 0.0);
      vertices.push(x, yBottom, z, u, 1.0);
    }

    for (let i = 0; i < slices; i++) {
      const topL = i * 2;
      const botL = topL + 1;
      const topR = (i + 1) * 2;
      const botR = topR + 1;

      indices.push(topL, botL, topR);
      indices.push(topR, botL, botR);
    }

    xrIndexCount = indices.length;

    xrVAO = gl.createVertexArray();
    gl.bindVertexArray(xrVAO);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'aPosition');
    const aTex = gl.getAttribLocation(prog, 'aTexCoord');

    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 5 * 4, 0);

    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 5 * 4, 3 * 4);

    gl.bindVertexArray(null);
  }

  function initXRTextures(gl) {
    function makeTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }
    xrTexLeft = makeTex();
    xrTexRight = makeTex();
  }

  function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    handleXRControllers(frame, xrRefSpace);

    const gl = xrGl;
    const lCanvas = iframeLeft?.contentWindow?.document?.querySelector('canvas');
    const rCanvas = iframeRight?.contentWindow?.document?.querySelector('canvas');

    if (lCanvas && xrTexLeft) {
      gl.bindTexture(gl.TEXTURE_2D, xrTexLeft);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lCanvas);
    }
    if (rCanvas && xrTexRight) {
      gl.bindTexture(gl.TEXTURE_2D, xrTexRight);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rCanvas);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
    gl.clearColor(0.01, 0.02, 0.03, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(xrProgram);
    gl.bindVertexArray(xrVAO);

    const uProjLoc = gl.getUniformLocation(xrProgram, 'uProjectionMatrix');
    const uViewLoc = gl.getUniformLocation(xrProgram, 'uViewMatrix');
    const uTexLoc = gl.getUniformLocation(xrProgram, 'uTexture');
    gl.uniform1i(uTexLoc, 0);

    for (const view of pose.views) {
      const viewport = xrLayer.getViewport(view);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);

      gl.uniformMatrix4fv(uProjLoc, false, view.projectionMatrix);
      gl.uniformMatrix4fv(uViewLoc, false, view.transform.inverse.matrix);

      gl.activeTexture(gl.TEXTURE0);
      const isRightEye = stereoState.swapEyes
        ? view.eye === 'left'
        : view.eye === 'right';

      gl.bindTexture(gl.TEXTURE_2D, isRightEye ? xrTexRight : xrTexLeft);
      gl.drawElements(gl.TRIANGLES, xrIndexCount, gl.UNSIGNED_SHORT, 0);
    }

    gl.bindVertexArray(null);
  }

  function handleXRControllers(frame, refSpace) {
    if (!xrSession) return;
    for (const source of xrSession.inputSources) {
      const gp = source.gamepad;
      if (!gp) continue;
      const hand = source.handedness;

      const stickX = gp.axes[2] !== undefined ? gp.axes[2] : gp.axes[0] || 0;
      const stickY = gp.axes[3] !== undefined ? gp.axes[3] : gp.axes[1] || 0;

      // Right controller: Dolly Zoom & Resolution / Zoom-Relative buttons
      if (hand === 'right') {
        if (Math.abs(stickY) > 0.18 && leftViewer?.projectionScale) {
          const factor = 1.0 + stickY * 0.035;
          leftViewer.projectionScale.value = Math.max(10, leftViewer.projectionScale.value * factor);
          refreshStereoProjection();
        }

        // Button A (index 4): Cycle Resolution Samples
        if (gp.buttons[4]?.pressed) {
          if (!xrButtonDebounce.a) {
            xrButtonDebounce.a = true;
            cycleResolutionSamples();
            gp.hapticActuators?.[0]?.pulse?.(0.7, 50);
          }
        } else {
          xrButtonDebounce.a = false;
        }

        // Button B (index 5): Toggle Zoom-Relative Depth
        if (gp.buttons[5]?.pressed) {
          if (!xrButtonDebounce.b) {
            xrButtonDebounce.b = true;
            toggleZoomRelative();
            gp.hapticActuators?.[0]?.pulse?.(0.7, 50);
          }
        } else {
          xrButtonDebounce.b = false;
        }
      }

      // Left controller: IPD adjustment, HUD toggle, Reset
      if (hand === 'left') {
        if (Math.abs(stickX) > 0.18) {
          setSeparation(stereoState.separationPercent + stickX * 0.12);
        }

        // Button X (index 4): Toggle HUD
        if (gp.buttons[4]?.pressed) {
          if (!xrButtonDebounce.x) {
            xrButtonDebounce.x = true;
            document.body.classList.toggle('hud-collapsed');
            gp.hapticActuators?.[0]?.pulse?.(0.5, 40);
          }
        } else {
          xrButtonDebounce.x = false;
        }

        // Button Y (index 5): Reset View
        if (gp.buttons[5]?.pressed) {
          if (!xrButtonDebounce.y) {
            xrButtonDebounce.y = true;
            resetCamera();
            gp.hapticActuators?.[0]?.pulse?.(0.5, 40);
          }
        } else {
          xrButtonDebounce.y = false;
        }
      }

      // 6DoF Drag Rotation via Controller (Trigger or Grip):
      const trigger = gp.buttons[0]?.pressed;
      const grip = gp.buttons[1]?.pressed;
      if (trigger || grip) {
        const pose = frame.getPose(source.gripSpace || source.targetRaySpace, refSpace);
        if (pose && leftViewer?.navigationState?.pose) {
          const pos = pose.transform.position;
          if (xrLastGrabPos[hand]) {
            const dx = (pos.x - xrLastGrabPos[hand].x) * 450.0;
            const dy = (pos.y - xrLastGrabPos[hand].y) * 450.0;
            if (Math.hypot(dx, dy) > 0.1) {
              const viewerPos = leftViewer.navigationState.pose.position.value;
              leftViewer.navigationState.pose.rotateAbsolute([0, 1, 0], -dx * 0.015, viewerPos);
              leftViewer.navigationState.pose.rotateAbsolute([1, 0, 0], -dy * 0.015, viewerPos);
              leftViewer.display.scheduleRedraw();
              refreshStereoProjection();
            }
          }
          xrLastGrabPos[hand] = { x: pos.x, y: pos.y, z: pos.z };
        }
      } else {
        xrLastGrabPos[hand] = null;
      }
    }
  }

  sliderSeparation.addEventListener('input', (e) => {
    setSeparation(parseFloat(e.target.value));
  });

  sliderConvergence.addEventListener('input', (e) => {
    setConvergence(parseFloat(e.target.value));
  });

  if (sliderPerspective) {
    sliderPerspective.addEventListener('input', (e) => {
      setPerspectiveFov(parseFloat(e.target.value));
    });
  }

  if (sliderDolly) {
    sliderDolly.addEventListener('input', (e) => {
      setAutoDolly(parseFloat(e.target.value));
    });
  }

  selectRenderMode.addEventListener('change', (e) => {
    stereoState.renderMode = e.target.value;
    const labels = {
      volume_only: 'Volume Only',
      volume_and_slices: 'Volume + Slices',
      mip_only: 'Max Projection',
      slices_only: 'Slices Only',
    };
    valRenderMode.textContent = labels[stereoState.renderMode] || 'Volume';
    updateLiveRenderingControls();
    showStereoToast(`3D Mode: ${valRenderMode.textContent}`);
  });

  sliderGain.addEventListener('input', (e) => {
    stereoState.volumeGain = parseFloat(e.target.value);
    valGain.textContent = stereoState.volumeGain.toFixed(1);
    updateLiveRenderingControls();
  });

  selectColormap.addEventListener('change', (e) => {
    stereoState.colormap = e.target.value;
    updateLiveRenderingControls();
  });

  presetEscargotBtn.addEventListener('click', () => loadPreset('escargot'));
  presetHipctBtn.addEventListener('click', () => loadPreset('hipct'));
  if (presetHeartBtn) presetHeartBtn.addEventListener('click', () => loadPreset('heart'));

  btnLoadCustom.addEventListener('click', () => {
    parseAndLoadCustomInput(customSourceInput.value);
  });

  customSourceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      parseAndLoadCustomInput(customSourceInput.value);
    }
  });

  btnAutoOrbit.addEventListener('click', () => {
    stereoState.autoOrbit = !stereoState.autoOrbit;
    btnAutoOrbit.classList.toggle('active', stereoState.autoOrbit);
    showStereoToast(stereoState.autoOrbit ? 'Auto-Orbit: ON' : 'Auto-Orbit: OFF');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = stereoState.autoOrbit ? 'playing' : 'paused';
      updateMediaSessionState();
    }
  });

  btnSwapEyes.addEventListener('click', () => {
    stereoState.swapEyes = !stereoState.swapEyes;
    btnSwapEyes.classList.toggle('active', stereoState.swapEyes);
    btnSwapEyes.textContent = stereoState.swapEyes
      ? '⇄ Swap Eyes (Cross-Eye)'
      : '⇄ Swap Eyes (Parallel)';
    badgeLeft.textContent = stereoState.swapEyes ? 'Right Eye (Cross)' : 'Left Eye';
    badgeRight.textContent = stereoState.swapEyes ? 'Left Eye (Cross)' : 'Right Eye';
    refreshStereoProjection();
    showStereoToast(
      stereoState.swapEyes ? 'Mode: Cross-Eye (R / L)' : 'Mode: Parallel VR (L / R)'
    );
  });

  btnLensFrame.addEventListener('click', () => {
    stereoStage.classList.toggle('vr-lens-mode');
    const active = stereoStage.classList.contains('vr-lens-mode');
    btnLensFrame.classList.toggle('active', active);
    showStereoToast(
      active
        ? 'Lens Mode: ON (Cardboard Circular Vignette)'
        : 'Full-Bleed SBS: ON (Edge-to-Edge)'
    );
  });

  if (btnToggleZoomRelative) {
    btnToggleZoomRelative.addEventListener('click', () => {
      toggleZoomRelative();
    });
  }

  if (selectDepthSamples) {
    selectDepthSamples.addEventListener('change', (e) => {
      setDepthSamples(e.target.value);
    });
  }

  if (btnCycleRes) {
    btnCycleRes.addEventListener('click', () => {
      cycleResolutionSamples();
    });
  }

  if (sliderAspect) {
    sliderAspect.addEventListener('input', (e) => {
      setAspectCorrection(parseFloat(e.target.value));
    });
  }

  if (btnToggleAspect) {
    btnToggleAspect.addEventListener('click', () => {
      toggleAspectCorrection();
    });
  }

  if (btnAspectFix) {
    btnAspectFix.addEventListener('click', () => {
      toggleAspectCorrection();
    });
  }

  if (btnCuboidLimit) {
    btnCuboidLimit.addEventListener('click', () => {
      toggleCuboidLimit();
    });
  }

  if (btnToggleCuboid) {
    btnToggleCuboid.addEventListener('click', () => {
      toggleCuboidLimit();
    });
  }

  if (btnCenterCuboid) {
    btnCenterCuboid.addEventListener('click', () => {
      centerCuboidOnView();
    });
  }

  if (selectCuboidSize) {
    selectCuboidSize.addEventListener('change', (e) => {
      setCuboidSize(e.target.value);
    });
  }

  if (btnCuboidCage) {
    btnCuboidCage.addEventListener('click', () => {
      toggleCuboidCage();
    });
  }

  btnNgUi.addEventListener('click', () => {
    updateNgUiVisibility(!stereoState.showNgUi);
    showStereoToast(
      stereoState.showNgUi ? 'Neuroglancer Layer UI: ON' : 'Neuroglancer Layer UI: OFF'
    );
  });

  btnCopyLink.addEventListener('click', () => {
    if (!leftViewer) return;
    const stateJson = leftViewer.state.toJSON();
    const params = new URLSearchParams();
    params.set('sep', String(stereoState.separationPercent));
    params.set('conv', String(stereoState.convergencePercent));
    params.set('fov', String(stereoState.perspectiveFovDeg));
    params.set('dolly', String(stereoState.autoDollyPercent));
    if (stereoState.aspectCorrection !== 1.0) {
      params.set('aspect', String(stereoState.aspectCorrection));
    }
    if (stereoState.cuboidLimit.enabled) {
      params.set('cuboid', String(stereoState.cuboidLimit.size));
    }
    if (stereoState.swapEyes) params.set('swap', '1');
    params.set('state', JSON.stringify(stateJson));

    const url = `${window.location.origin}${window.location.pathname}#${params.toString()}`;
    window.history.replaceState(null, '', `#${params.toString()}`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        showStereoToast('Copied Shareable 3D VR Link!');
      });
    } else {
      showStereoToast('Updated URL Hash with 3D State!');
    }
  });

  btnFullscreen.addEventListener('click', () => {
    toggleFullscreen();
  });

  hudToggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('hud-collapsed');
  });

  btnCloseHud?.addEventListener('click', () => {
    document.body.classList.add('hud-collapsed');
  });

  btnRotateFs?.addEventListener('click', () => {
    toggleFullscreen();
  });

  let screenWakeLock = null;
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        screenWakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {}
    }
  }

  function releaseWakeLock() {
    if (screenWakeLock) {
      screenWakeLock.release().catch(() => {});
      screenWakeLock = null;
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      screen.orientation?.lock?.('landscape').catch(() => {});
      requestWakeLock();
      document.body.classList.add('hud-collapsed');
      showStereoToast('Cardboard VR Fullscreen');
    } else {
      document.exitFullscreen?.().catch(() => {});
      releaseWakeLock();
      document.body.classList.remove('hud-collapsed');
    }
  }

  // ============================================================================
  // Mobile Gyroscope Head Tracking for Google Cardboard (3DoF)
  // ============================================================================
  let gyroActive = false;
  let lastOrientation = null;

  async function toggleGyroTracking() {
    if (gyroActive) {
      disableGyroTracking();
      return;
    }

    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          showStereoToast('Gyro Permission Denied');
          return;
        }
      } catch (err) {
        console.warn('DeviceOrientation error:', err);
      }
    }

    enableGyroTracking();
  }

  function enableGyroTracking() {
    gyroActive = true;
    lastOrientation = null;
    window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });
    if (btnGyroTrack) {
      btnGyroTrack.classList.add('active');
      btnGyroTrack.textContent = '🎯 Gyro: ON';
    }
    requestWakeLock();
    showStereoToast('🎯 Cardboard Gyro: ON (Move phone to look around)');
  }

  function disableGyroTracking(silent = false) {
    gyroActive = false;
    lastOrientation = null;
    window.removeEventListener('deviceorientation', handleDeviceOrientation);
    if (btnGyroTrack) {
      btnGyroTrack.classList.remove('active');
      btnGyroTrack.textContent = '🎯 Gyro: OFF';
    }
    if (!silent) {
      showStereoToast('🎯 Cardboard Gyro: OFF');
    }
  }

  function handleDeviceOrientation(e) {
    if (!gyroActive || !leftViewer?.navigationState?.pose) return;
    const { alpha, beta, gamma } = e;
    if (alpha === null || beta === null || gamma === null) return;

    if (!lastOrientation) {
      lastOrientation = { alpha, beta, gamma };
      return;
    }

    let dAlpha = alpha - lastOrientation.alpha;
    let dBeta = beta - lastOrientation.beta;
    let dGamma = gamma - lastOrientation.gamma;

    if (dAlpha > 180) dAlpha -= 360;
    if (dAlpha < -180) dAlpha += 360;

    lastOrientation = { alpha, beta, gamma };

    const orient = window.orientation || (screen.orientation && screen.orientation.angle) || 90;
    const isReverseLandscape = orient === -90 || orient === 270;

    const pitchDelta = (isReverseLandscape ? -dGamma : dGamma) * (Math.PI / 180);
    const yawDelta = -dAlpha * (Math.PI / 180);

    const pos = leftViewer.navigationState.pose.position.value;
    if (Math.abs(yawDelta) > 0.001) {
      leftViewer.navigationState.pose.rotateAbsolute([0, 1, 0], yawDelta * 0.85, pos);
    }
    if (Math.abs(pitchDelta) > 0.001) {
      leftViewer.navigationState.pose.rotateAbsolute([1, 0, 0], pitchDelta * 0.85, pos);
    }
    leftViewer.display.scheduleRedraw();
    refreshStereoProjection();
  }

  btnGyroTrack?.addEventListener('click', () => {
    toggleGyroTracking();
  });

  function checkOrientation() {
    const isPortrait = window.matchMedia('(orientation: portrait) and (max-width: 900px)').matches;
    if (landscapePrompt) {
      landscapePrompt.style.display = isPortrait ? 'block' : 'none';
    }
  }
  window.addEventListener('orientationchange', checkOrientation);
  window.addEventListener('resize', checkOrientation);
  checkOrientation();

  function handleGlobalHotkeys(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === '[' || e.key === '{') {
      e.preventDefault();
      setSeparation(stereoState.separationPercent - 0.5);
      showStereoToast(`Stereo Shift (IPD): ${stereoState.separationPercent.toFixed(2)}%`);
    } else if (e.key === ']' || e.key === '}') {
      e.preventDefault();
      setSeparation(stereoState.separationPercent + 0.5);
      showStereoToast(`Stereo Shift (IPD): ${stereoState.separationPercent.toFixed(2)}%`);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setConvergence(stereoState.convergencePercent - 10);
      showStereoToast(`Convergence: ${stereoState.convergencePercent}%`);
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      setConvergence(stereoState.convergencePercent + 10);
      showStereoToast(`Convergence: ${stereoState.convergencePercent}%`);
    } else if (e.key === ',' || e.key === '<') {
      e.preventDefault();
      setPerspectiveFov(stereoState.perspectiveFovDeg - 4);
      showStereoToast(`3D Perspective FOV: ${stereoState.perspectiveFovDeg}°`);
    } else if (e.key === '.' || e.key === '>') {
      e.preventDefault();
      setPerspectiveFov(stereoState.perspectiveFovDeg + 4);
      showStereoToast(`3D Perspective FOV: ${stereoState.perspectiveFovDeg}°`);
    } else if (e.key === 'h') {
      e.preventDefault();
      e.stopPropagation();
      updateNgUiVisibility(!stereoState.showNgUi);
      showStereoToast(
        stereoState.showNgUi ? 'Neuroglancer HUD: ON' : 'Neuroglancer HUD: OFF'
      );
    } else if (e.key === 'H') {
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.toggle('hud-collapsed');
      showStereoToast(
        document.body.classList.contains('hud-collapsed')
          ? 'VR Controls: Hidden (Shift+H to show)'
          : 'VR Controls: Visible'
      );
    } else if (e.key === 'z') {
      e.preventDefault();
      toggleZoomRelative();
    } else if (e.key === 'Z') {
      e.preventDefault();
      cycleResolutionSamples();
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      toggleAspectCorrection();
    } else if (e.key === 'c') {
      e.preventDefault();
      toggleCuboidLimit();
    } else if (e.key === 'C') {
      e.preventDefault();
      centerCuboidOnView();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      btnSwapEyes.click();
    } else if (e.key === 'o' || e.key === 'O') {
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        btnAutoOrbit.click();
      }
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      const modes = ['volume_only', 'volume_and_slices', 'mip_only', 'slices_only'];
      const nextIdx = (modes.indexOf(stereoState.renderMode) + 1) % modes.length;
      selectRenderMode.value = modes[nextIdx];
      selectRenderMode.dispatchEvent(new Event('change'));
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      if (stereoState.activePreset) {
        loadPreset(stereoState.activePreset);
      } else if (leftViewer) {
        leftViewer.projectionOrientation.reset();
        leftViewer.projectionScale.reset();
      }
      showStereoToast('Reset 3D Camera Pose');
    }
  }

  window.addEventListener('keydown', handleGlobalHotkeys);

  // ============================================================================
  // 12. Startup & Initialization
  // ============================================================================
  function tryRestoreFromUrlHash() {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return false;

    if (hash.startsWith('#!')) {
      customSourceInput.value = hash;
      parseAndLoadCustomInput(hash);
      return true;
    }

    const raw = hash.slice(1);
    const params = new URLSearchParams(raw);
    if (params.has('sep')) {
      setSeparation(parseFloat(params.get('sep')));
    }
    if (params.has('conv')) {
      setConvergence(parseFloat(params.get('conv')));
    }
    if (params.has('fov')) {
      setPerspectiveFov(parseFloat(params.get('fov')));
    }
    if (params.has('dolly')) {
      setAutoDolly(parseFloat(params.get('dolly')));
    }
    if (params.has('aspect')) {
      setAspectCorrection(parseFloat(params.get('aspect')));
    }
    if (params.has('cuboid')) {
      stereoState.cuboidLimit.enabled = true;
      stereoState.cuboidLimit.size = parseInt(params.get('cuboid'), 10) || 512;
    }
    if (params.get('swap') === '1') {
      stereoState.swapEyes = true;
      btnSwapEyes.classList.add('active');
    }
    if (params.has('state')) {
      try {
        const stateObj = JSON.parse(params.get('state'));
        applyStateToBothViewers(stateObj);
        return true;
      } catch (e) {
        console.warn('Could not restore state from URL hash:', e);
      }
    }
    return false;
  }

  function waitForViewersReady() {
    const vLeft = iframeLeft.contentWindow && iframeLeft.contentWindow.viewer;
    const vRight = iframeRight.contentWindow && iframeRight.contentWindow.viewer;

    if (!vLeft || !vRight) {
      requestAnimationFrame(waitForViewersReady);
      return;
    }

    leftViewer = vLeft;
    rightViewer = vRight;

    installStereoCameraHook(iframeLeft, leftViewer, -1);
    installStereoCameraHook(iframeRight, rightViewer, +1);

    bindBidirectionalSync(leftViewer, rightViewer);

    setupStereoCursorAndEvents(iframeLeft);
    setupStereoCursorAndEvents(iframeRight);

    if (!tryRestoreFromUrlHash()) {
      loadPreset('escargot');
    }

    // Initialize WebXR for Meta Quest 2 and VR headsets
    initWebXR();

    // Initialize Media Session API for Meta Quest SBS video playback bar (+-10s rotation, Play/Pause orbit)
    initMediaSession();

    // Ensure gyro head tracking is disabled by default everywhere
    disableGyroTracking(true);

    // Ensure initial Zoom-relative mode and sampling resolution are set
    toggleZoomRelative(stereoState.zoomRelative);

    // Initialize 3D cuboid limit state
    applyCuboidLimit(false);

    syncDot.classList.add('ready');
    syncLabel.textContent = 'Stereo 3D Lockstep Sync Active (60 FPS)';
  }

  waitForViewersReady();
})();
