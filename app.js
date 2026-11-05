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
      win.vrStereoHook = function (panelNavState, panel) {
        const rawZoom =
          panelNavState?.zoomFactor?.value ??
          viewer?.perspectiveNavigationState?.zoomFactor?.value ??
          960;
        const proj = computeEffectiveProjection(viewer, rawZoom);

        const effectiveSign = eyeSign * (stereoState.swapEyes ? -1 : 1);
        const baseHalfShift = effectiveSign * (stereoState.separationPercent / 100) * 0.5;
        const halfShift = baseHalfShift * proj.stereoZoomCompensation;
        const convFraction = stereoState.convergencePercent / 100;

        return {
          fov: proj.fov,
          zoom: proj.zoom,
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

    doc.addEventListener(
      'mousemove',
      (e) => {
        const w = win.innerWidth || 1;
        const h = win.innerHeight || 1;
        const xPct = (e.clientX / w) * 100;
        const yPct = (e.clientY / h) * 100;
        reticleLeft.style.left = `${xPct}%`;
        reticleLeft.style.top = `${yPct}%`;
        reticleRight.style.left = `${xPct}%`;
        reticleRight.style.top = `${yPct}%`;
        reticleLeft.classList.add('visible');
        reticleRight.classList.add('visible');
      },
      { passive: true }
    );

    doc.addEventListener(
      'mouseleave',
      () => {
        reticleLeft.classList.remove('visible');
        reticleRight.classList.remove('visible');
      },
      { passive: true }
    );

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
  // 10. Auto-Orbit Turntable Animation Loop
  // ============================================================================
  let lastOrbitTime = performance.now();
  function orbitAnimationLoop(now) {
    const dt = Math.min(0.1, (now - lastOrbitTime) / 1000);
    lastOrbitTime = now;

    if (stereoState.autoOrbit && leftViewer && rightViewer) {
      const angle = dt * 0.32;
      const half = angle * 0.5;
      const ry = Math.sin(half);
      const rw = Math.cos(half);

      const q = leftViewer.projectionOrientation.orientation;
      const q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
      q[0] = q0 * rw - q2 * ry;
      q[1] = q1 * rw + q3 * ry;
      q[2] = q2 * rw + q0 * ry;
      q[3] = q3 * rw - q1 * ry;

      leftViewer.projectionOrientation.changed.dispatch();
    }

    requestAnimationFrame(orbitAnimationLoop);
  }
  requestAnimationFrame(orbitAnimationLoop);

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
  });

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

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
      document.body.classList.add('hud-collapsed');
      showStereoToast('VR Fullscreen (Press Shift+H for Controls)');
    } else {
      document.exitFullscreen?.().catch(() => {});
      document.body.classList.remove('hud-collapsed');
    }
  }

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

    syncDot.classList.add('ready');
    syncLabel.textContent = 'Stereo 3D Lockstep Sync Active (60 FPS)';
  }

  waitForViewersReady();
})();
