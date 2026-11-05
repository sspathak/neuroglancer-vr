# VRZarr — Stereoscopic 3D Neuroglancer Viewer

A zero-dependency static webpage that renders two synchronized **Neuroglancer** 3D views Side-by-Side (SBS) for VR viewers (Google Cardboard, Meta Quest Browser SBS mode, 3D monitors/AR glasses, or free-viewing).

## Quick Start

Serve the directory with any static file server:

```bash
python3 -m http.server 8080
```

Then open **http://localhost:8080** in your browser or VR headset.

## Deploying to GitHub Pages

VRZarr is 100% static (HTML, CSS, JS, WASM) and runs entirely in the browser without any backend server.

An automated GitHub Actions workflow is included at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

1. Push this directory to your GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of VRZarr"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. In your GitHub repository, go to **Settings** → **Pages**.
3. Under **Build and deployment** → **Source**, select **GitHub Actions**.
4. The workflow will run automatically on push and publish your site at `https://<your-username>.github.io/<your-repo>/`.

## Key Features

- **Camera-Relative 3D Stereoscopic Shift (`installStereoCameraHook`)**:
  - Hooks directly into `viewer.perspectiveNavigationState.pose.toMat4(mat, scale)` on the Left Eye (`-1`) and Right Eye (`+1`) Neuroglancer engines.
  - Shifts each eye laterally along the **camera's local horizontal axis** (`R * [1, 0, 0]`) scaled by the current 3D zoom level (`projectionScale`), and converges at the 3D focal point (`viewer.position`) so rotating the volume to any angle or zooming in/out maintains natural, comfortable 3D depth.
  - Keeps `viewer.position` (`navigationState.pose.position`) identical between both eyes so 3D intersecting cross-section slice planes cut through the **exact same anatomical slice** in both eyes without binocular rivalry.
- **3D Dolly Zoom & Perspective Foreshortening**:
  - Solves the classic "zooming breaks 3D" problem. Pure uniform scaling flattens 3D depth into a 2D placard; VRZarr integrates a **true 3D Dolly Projection Hook** into Neuroglancer's WebGL projection matrix builder.
  - When zooming in, the virtual camera physically approaches the 3D specimen and widens the perspective field-of-view (FOV) from a telephoto overview up to wide-angle proximity, producing natural perspective foreshortening distortion where near structures expand faster than far structures.
  - **Dynamic Stereo Disparity Stabilization**: Automatically recalibrates IPD and convergence angle against effective camera proximity so zooming deep into internal structures never induces divergent double vision.
  - Directly controllable via the **3D Perspective (FOV)** and **Zoom → 3D Dolly** sliders in the HUD, or using `,` / `.` hotkeys.
- **60 FPS Lockstep Bidirectional Sync**:
  - Rotating, panning, zooming, or scrolling through slices in **either** eye immediately synchronizes `position`, `projectionOrientation`, `projectionScale`, `projectionDepthRange`, `crossSectionOrientation`, `crossSectionScale`, and adaptive volume downsampling (`flagContinuousCameraMotion`) to the other eye.
  - **Bidirectional Contrast & Shader Sync**: Adjusting contrast (`range`, `window`, transfer function controls), color tint, opacity, volume gain, or shader code in **either** eye (using the Neuroglancer layer panel via `h`) instantly mirrors to the other eye in real time.
  - Direct mouse wheel or trackpad pinch in either eye triggers smooth 3D Dolly Zoom; `Shift + Wheel` navigates the cross-section slice plane.
- **Built-in 3D Zarr v3 / OME-Zarr v0.5 Presets**:
  1. **Escargot (QIM 3D Micro-CT)**: `https://public.qim.dk/escargot/escargot.zarr/`
  2. **Human Brain Left Hemisphere (UCL HiP-CT 20.07 µm)**: `gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/I74/brain-left_hemisphere/20.07um_overview_bm18.ome.zarr`
  3. **Human Heart Complete Organ (UCL HiP-CT 8.01 µm)**: `gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/LADAF-2021-17/heart/8.01um_complete-organ_bm18.ome.zarr/`
- **Embedded Neuroglancer Link & State Loader**:
  - Paste any full Neuroglancer link (`https://.../#!...`), state JSON (`{"dimensions":...}`), or state URL (`gs://.../state.json`, `https://.../state.json`, `?json_url=...`).
  - **Automatic Contrast & Location Ingestion**: Automatically extracts the dataset's exact contrast limits (`range` and `window`), 3D camera focal point (`position`), physical voxel scales and units (`dimensions`), and orientation.
  - **Full 3D Layer & Annotation Preservation**: Preserves all image layers and renders all 3D bounding boxes (`axis_aligned_bounding_box`), points, lines, and ROIs in both eyes in true stereoscopic depth.
  - **Auto-3D Volume Upgrade**: Standard 2D slice shaders in the link are automatically adapted for 3D translucent volume rendering without altering the underlying contrast settings.
  - Also supports direct raw dataset URLs (`gs://...`, `https://...`, `s3://...`, `zarr://...`, `precomputed://...`).
- **VR Ergonomics**:
  - **Synchronized Stereo 3D Reticle**: Renders a matched cursor in both eyes simultaneously so your eyes never see a single-eye OS cursor in VR.
  - **Dual-Eye Stereo HUD Toasts**: Keyboard adjustments display a synchronized stereo notification in both eyes so you can read parameter changes without removing your headset.

- **Quest SBS Horizontal Stretch Fix (`A` key / Slider / Header Button)**:
  - When viewing Side-by-Side (SBS) stereoscopic content in Meta Quest's browser or media viewer, the viewer treats each eye viewport as an anamorphic **Half-SBS** frame and stretches each half horizontally by **2.0×** to fill a 16:9 field of view.
  - On a standard window without correction, this causes spherical organs and voxels to appear severely widened (oval/distorted).
  - VRZarr introduces a direct **Projection Matrix Aspect Correction hook** (`vrStereoHook`) into Neuroglancer's WebGL camera builder:
    - Setting Aspect Correction to **`0.50x`** pre-squeezes the horizontal projection matrix in clip space ($0.5 \times 2.0 = 1.0$), perfectly neutralizing Quest's 2× stretch and restoring true 1:1 isometric voxel proportions!
    - Toggle with hotkey **`A`**, the **`⇋ Aspect Fix`** header button, or fine-tune between `0.40x` and `1.40x` with the SBS Aspect slider in Control Card 9.

- **Mobile Browser & Google Cardboard Support**:
  - **Adaptive Responsive HUD**: Fully touch-friendly and smoothly scrollable on iOS Safari and Android Chrome, preventing UI cutoffs on small screens.
  - **Phone Gyroscope 3DoF Head Tracking (`🎯 Gyro`)**:
    - **Disabled by default everywhere**: Gyro tracking will *never* activate automatically on page load, fullscreen, or headset connection.
    - When placing your phone into a Google Cardboard or mobile VR headset, tap **`🎯 Gyro: OFF`** to request sensor permission and activate real-time 3DoF pitch/yaw head tracking.
    - Automatically accounts for landscape and reverse-landscape phone orientations.

- **Zoom-Relative Depth Mode & 3D Resolution Multipliers**:
  - Keep the exact same camera framing and zoom while dramatically increasing 3D voxel resolution.
  - **Zoom-Relative Depth Mode (`Z` / Button `B`)**: In Neuroglancer, toggles between fixed depth range and relative depth range (`projectionDepthRange < 0`). When enabled, the sampling depth automatically tightens with zoom, eliminating coarse stair-stepping and clipping.
  - **3D Raycast Resolution (`Shift+Z` / Button `A`)**: Dynamically sets `volumeRenderingDepthSamplesTarget` (128, 192, 256, 384, 512, 768, 1024 samples) across all image layers in both eyes simultaneously.
- **Oculus Quest 2 & Meta Quest Browser Immersion**:
  - **Native WebXR 6DoF Mode (`🥽 Enter VR`)**: Automatically detected on Meta Quest Browser. Clicking "Enter VR" launches true 6DoF immersive stereoscopic VR on an IMAX-sized curved virtual display that wraps comfortably around the user.
  - **Quest Touch Controllers**:
    - **Trigger / Grip Drag**: Natural 6DoF rotation of the 3D volume in mid-air.
    - **Right Thumbstick Y**: Smooth 3D Dolly Zoom in and out.
    - **Left Thumbstick X**: Adjust camera-relative Stereo Eye Separation (IPD).
    - **Button A (Right Controller)**: Cycle 3D Raycast Resolution (128 → 256 → 512 → 1024 samples) with haptic rumble.
    - **Button B (Right Controller)**: Toggle Zoom-Relative Depth Mode with haptic rumble.
    - **Button X (Left Controller)**: Toggle VR Controls Dock.
    - **Button Y (Left Controller)**: Reset 3D camera pose.
  - **Quest Browser Formatting Guide**:
    - **Why 180°/360° looks broken**: The Quest Browser's 180° and 360° video modes project onto a spherical dome (for 360 camera video), warping flat rectilinear 3D perspective graphics into curved distortion.
    - **Why Quest's Media Player locks interaction**: Meta's video player treats pages as passive movies and intercepts controller laser-pointers.
    - **The Solution**: Use **`🥽 Enter VR`** for native 6DoF immersion, or use Quest Browser in normal window mode with **"Switch to Giant Curved Display"** instead of the video player.

## Keyboard Shortcuts (Work in Fullscreen VR)

| Key | Action |
| --- | --- |
| `[` / `]` | Decrease / Increase Stereo Eye Shift (IPD) |
| `-` / `=` | Decrease / Increase Convergence (Focal Plane Depth) |
| `,` / `.` | Decrease / Increase 3D Perspective FOV (Lens Distortion) |
| `Z` | Toggle Zoom-Relative Depth Range Mode |
| `Shift+Z` | Cycle 3D Raycast Resolution (128 → 256 → 512 → 1024 samples) |
| `A` | Toggle SBS Aspect Ratio Fix (1.0x Normal ↔ 0.5x Quest SBS Stretch Fix) |
| `V` | Cycle 3D Rendering Mode (Volume Only → Volume + Slices → MIP → Slices Only) |
| `O` | Toggle Hands-Free 3D Auto-Orbit Turntable |
| `X` | Swap Left / Right Eyes (Parallel vs. Cross-Eye mode) |
| `R` | Reset 3D Camera Orientation & Zoom |
| `F` | Toggle Fullscreen (auto-hides HUD) |
| `h` | Toggle Neuroglancer HUD (Layer panel, dimension bars, shaders) |
| `H` / `Shift+H` | Toggle VR Controls Dock (Top stereoscopic controls) |
