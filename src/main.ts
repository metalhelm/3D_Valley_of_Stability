import * as THREE from 'three';

interface DecayMode {
  mode: string;
  fraction: number;
}

interface Nuclide {
  id: string;
  Z: number;
  N: number;
  symbol: string;
  mass: number;
  is_stable: boolean;
  half_life: string;
  half_life_sec: number | null;
  binding_kev: number;
  binding_mev: number;
  mass_excess_mev: number;
  decay_modes: DecayMode[];
}

type ElevationScaleMode = 'log' | 'sqrt' | 'linear';
type HeightMode = 'binding' | 'halflife';
type ColorOverlayMode = 'decay' | 'halflife' | 'elevation' | 'binding';

// Standard nuclear magic numbers (Mayer & Jensen shell model)
const MAGIC_Z = new Set([2, 8, 20, 28, 50, 82, 126]);
const MAGIC_N = new Set([2, 8, 20, 28, 50, 82, 126]);

class NuclideApp {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;

  // First-person free flight camera (Minecraft creative mode style: in-place self-pivot)
  private yaw: number = 0;
  private pitch: number = 0;
  private isDragging: boolean = false;
  private dragButton: number = 0; // 0: Left (look), 2: Right (pan)
  private lastMouseX: number = 0;
  private lastMouseY: number = 0;

  // Nuclide data & meshes
  private nuclides: Nuclide[] = [];
  private instancedMesh: THREE.InstancedMesh | null = null;
  private capMesh: THREE.InstancedMesh | null = null;
  private highlightBox: THREE.LineSegments | null = null;

  // Magic number contour meshes
  private magicLinesMesh: THREE.LineSegments | null = null;
  private magicBoxMesh: THREE.InstancedMesh | null = null;
  private magicPositions: Float32Array | null = null;
  private magicNuclideIndices: number[] = [];
  private showMagicNumbers: boolean = true;

  // Keyboard navigation
  private keys: Record<string, boolean> = {};

  // Raycasting for hover
  private raycaster: THREE.Raycaster;
  private mouse: THREE.Vector2;
  private hoveredInstanceId: number | null = null;

  // DOM elements
  private headerPanel: HTMLElement | null;
  private hudPanel: HTMLElement | null;
  private btnCollapseHeader: HTMLButtonElement | null;
  private btnCollapseHud: HTMLButtonElement | null;
  private hudTitle: HTMLElement | null;
  private hudDetails: HTMLElement | null;
  private statsBadge: HTMLElement | null;
  private appSubtitle: HTMLElement | null;
  private legendDecay: HTMLElement | null;
  private legendThermal: HTMLElement | null;
  private thermalColdLabel: HTMLElement | null;
  private thermalHotLabel: HTMLElement | null;
  private thermalTicksRow: HTMLElement | null;
  private btnOverlayVar: HTMLButtonElement | null;
  private toggleInvertBtn: HTMLButtonElement | null;
  private invertBtnText: HTMLElement | null;
  private toggleMagicBtn: HTMLButtonElement | null;
  private magSlider: HTMLInputElement | null;
  private magInput: HTMLInputElement | null;

  // Landscape & mode constants:
  // Fe-56 / Ni-62 max binding energy is ~8.790356 MeV
  private readonly MAX_BINDING = 8.7903563;

  // Half-life calculations:
  // Stable isotopes are assumed to have a 10 billion year half-life (10 * 10^9 yr = 3.15576e17 s)
  // which produces a smooth continuous heatmap coloring and heightmap elevation across all isotopes.
  private readonly TEN_BILLION_YEARS_SEC = 10 * 1e9 * 365.25 * 86400;
  private readonly MIN_LOG_HL = -22.0; // Prompt drip-line unbound nuclei emission (~10^-22 s)
  private readonly MAX_LOG_HL = Math.log10(10 * 1e9 * 365.25 * 86400); // ~17.4991

  private scaleMode: ElevationScaleMode = 'log';
  private heightMode: HeightMode = 'binding';
  private colorOverlay: ColorOverlayMode = 'decay';
  private heightMagnification: number = 1.0;

  constructor() {
    this.canvas = document.getElementById('webgl-canvas') as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error('Canvas element #webgl-canvas not found.');
    }

    this.headerPanel = document.getElementById('header-panel');
    this.hudPanel = document.getElementById('isotope-hud');
    this.btnCollapseHeader = document.getElementById('btn-collapse-header') as HTMLButtonElement | null;
    this.btnCollapseHud = document.getElementById('btn-collapse-hud') as HTMLButtonElement | null;

    this.hudTitle = document.getElementById('hud-title');
    this.hudDetails = document.getElementById('hud-details');
    this.statsBadge = document.getElementById('stats-badge');
    this.appSubtitle = document.getElementById('app-subtitle');
    this.legendDecay = document.getElementById('legend-decay');
    this.legendThermal = document.getElementById('legend-thermal');
    this.thermalColdLabel = document.getElementById('thermal-label-cold');
    this.thermalHotLabel = document.getElementById('thermal-label-hot');
    this.thermalTicksRow = document.getElementById('thermal-ticks-row');
    this.btnOverlayVar = document.getElementById('btn-overlay-var') as HTMLButtonElement | null;
    this.toggleInvertBtn = document.getElementById('toggle-invert-mode') as HTMLButtonElement | null;
    this.invertBtnText = document.getElementById('invert-btn-text');
    this.toggleMagicBtn = document.getElementById('toggle-magic-numbers') as HTMLButtonElement | null;
    this.magSlider = document.getElementById('height-mag-slider') as HTMLInputElement | null;
    this.magInput = document.getElementById('height-mag-input') as HTMLInputElement | null;

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-999, -999);

    // 1. Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    this.scene.fog = new THREE.FogExp2(0x0a0c12, 0.0035);

    // 2. Camera setup - sweeping view across the Valley of Stability canyon
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.5, 2000);
    this.camera.position.set(95, 45, 135);

    // Initial look orientation towards center of the valley (75, 4, 50)
    const initialLookTarget = new THREE.Vector3(75, 4, 50);
    const initialDir = new THREE.Vector3().subVectors(initialLookTarget, this.camera.position).normalize();
    this.pitch = Math.asin(Math.max(-0.999, Math.min(0.999, initialDir.y)));
    this.yaw = Math.atan2(-initialDir.x, -initialDir.z);
    this.updateCameraRotation();

    // 3. Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    // 4. Lighting & Scene Helpers
    this.setupLighting();
    this.setupHelpers();

    // 5. Highlight outline box for hovered isotope
    this.setupHighlightBox();

    // 6. Event listeners
    this.setupEventListeners();

    // 7. Fetch data & build 3D nuclide canyon
    this.loadNuclideData();

    // 8. Start render & update loop
    this.animate();
  }

  private updateCameraRotation(): void {
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }

  private setupLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.3);
    dirLight1.position.set(120, 150, 90);
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x7dd3fc, 0.5);
    dirLight2.position.set(-60, 40, -40);
    this.scene.add(dirLight2);

    const dirLight3 = new THREE.DirectionalLight(0xe0f2fe, 0.35);
    dirLight3.position.set(60, -20, 180);
    this.scene.add(dirLight3);
  }


  private setupHelpers(): void {
    // Large grid spanning N (0 to ~180) and Z (0 to ~120)
    // Centered at N=90, Z=60
    const grid = new THREE.GridHelper(260, 52, 0x334155, 0x1e293b);
    grid.position.set(90, 0, 60);
    this.scene.add(grid);

    // Axes helper at origin (0, 0, 0)
    // Red = X (Neutron N), Green = Y (Binding Energy Height), Blue = Z (Proton Z)
    const axes = new THREE.AxesHelper(20);
    axes.position.set(0, 0.02, 0);
    this.scene.add(axes);
  }

  private setupHighlightBox(): void {
    const boxGeo = new THREE.BoxGeometry(1.02, 1, 1.02);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      linewidth: 2,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
    this.highlightBox = new THREE.LineSegments(edges, lineMat);
    this.highlightBox.visible = false;
    this.highlightBox.renderOrder = 999;
    this.scene.add(this.highlightBox);
  }

  private setupEventListeners(): void {
    window.addEventListener('resize', this.onWindowResize.bind(this));

    // 1. Panel collapse toggles (shrinks legend & controls to small button)
    if (this.btnCollapseHeader && this.headerPanel) {
      const toggleHeader = () => {
        const isCollapsed = this.headerPanel!.classList.toggle('collapsed');
        const icon = this.btnCollapseHeader!.querySelector('.collapse-icon');
        if (icon) icon.textContent = isCollapsed ? '+' : '−';
        this.btnCollapseHeader!.title = isCollapsed ? 'Expand Legend & Controls' : 'Shrink to small button (free up 3D view)';
      };

      this.btnCollapseHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHeader();
      });

      this.headerPanel.addEventListener('click', () => {
        if (this.headerPanel!.classList.contains('collapsed')) {
          toggleHeader();
        }
      });
    }

    if (this.btnCollapseHud && this.hudPanel) {
      const toggleHud = () => {
        const isCollapsed = this.hudPanel!.classList.toggle('collapsed');
        const icon = this.btnCollapseHud!.querySelector('.collapse-icon');
        if (icon) icon.textContent = isCollapsed ? '+' : '−';
        this.btnCollapseHud!.title = isCollapsed ? 'Expand Isotope Info' : 'Shrink to small button (free up 3D view)';
      };

      this.btnCollapseHud.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHud();
      });

      this.hudPanel.addEventListener('click', () => {
        if (this.hudPanel!.classList.contains('collapsed')) {
          toggleHud();
        }
      });
    }

    // 2. Mouse look & pan (Minecraft creative fly camera - pivots around itself)
    this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button === 0 || e.button === 2) {
        this.isDragging = true;
        this.dragButton = e.button;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    });

    this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
      // Update normalized coordinates for raycasting
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

      if (!this.isDragging) return;

      const deltaX = e.clientX - this.lastMouseX;
      const deltaY = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.dragButton === 0) {
        // Left click drag: Look around (yaw & pitch pivot around camera position in-place)
        const sensitivity = 0.0028;
        this.yaw -= deltaX * sensitivity;
        this.pitch -= deltaY * sensitivity;

        // Clamp pitch so camera cannot flip upside down (approx ±88.8 degrees)
        const maxPitch = Math.PI / 2 - 0.02;
        this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
        this.updateCameraRotation();
      } else if (this.dragButton === 2) {
        // Right click drag: Screen-space pan
        const panSpeed = 0.06;
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
        this.camera.position.addScaledVector(right, -deltaX * panSpeed);
        this.camera.position.y += deltaY * panSpeed;
      }
    });

    const stopDrag = (e: PointerEvent) => {
      if (this.isDragging) {
        this.isDragging = false;
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);

    // Prevent context menu on right click pan
    this.canvas.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
    });

    // Mouse wheel: Dolly / zoom forward/backward along view direction
    this.canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const zoomSpeed = 0.05;
      const forward = new THREE.Vector3(
        -Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        -Math.cos(this.yaw) * Math.cos(this.pitch)
      ).normalize();
      this.camera.position.addScaledVector(forward, -e.deltaY * zoomSpeed);
    }, { passive: false });

    // 3. Keyboard navigation (WASD, Arrows, Space, Ctrl, C, Shift)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      this.keys[e.code] = true;

      // Prevent default browser shortcuts for game flight keys (like Space scrolling, Ctrl+W closing tab)
      if (
        ['Space', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) ||
        (e.ctrlKey && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC'].includes(e.code))
      ) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    });

    // Elevation scale mode buttons
    const scaleButtons = document.querySelectorAll<HTMLButtonElement>('.scale-btn');
    scaleButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.scale as ElevationScaleMode;
        if (mode) {
          this.setScaleMode(mode);
        }
      });
    });

    // Height magnification slider & numeric input
    if (this.magSlider && this.magInput) {
      const slider = this.magSlider;
      const input = this.magInput;

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        if (!isNaN(val)) {
          input.value = val.toFixed(2);
          this.setHeightMagnification(val);
        }
      });

      input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        if (!isNaN(val) && val >= 1 && val <= 5.0) {
          slider.value = val.toString();
          this.setHeightMagnification(val);
        }
      });

      input.addEventListener('change', () => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = 1.0;
        val = Math.max(1, Math.min(5.0, val));
        input.value = val.toFixed(2);
        slider.value = val.toString();
        this.setHeightMagnification(val);
      });

      // Double-click to reset magnification to 1.0x
      const resetMag = () => {
        slider.value = '1';
        input.value = '1.00';
        this.setHeightMagnification(1.0);
      };
      slider.addEventListener('dblclick', resetMag);
      input.addEventListener('dblclick', resetMag);
    }

    // Color overlay selection buttons
    const overlayButtons = document.querySelectorAll<HTMLButtonElement>('.overlay-btn');
    overlayButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.overlay as ColorOverlayMode;
        if (mode) {
          this.setColorOverlay(mode);
        }
      });
    });

    // Invert height & color toggle button
    if (this.toggleInvertBtn) {
      this.toggleInvertBtn.addEventListener('click', () => {
        this.toggleInvertMode();
      });
    }

    // Magic numbers contour toggle button
    if (this.toggleMagicBtn) {
      this.toggleMagicBtn.addEventListener('click', () => {
        this.toggleMagicNumbers();
      });
    }
  }

  public setColorOverlay(mode: ColorOverlayMode): void {
    this.colorOverlay = mode;

    // Update active UI button style
    const overlayButtons = document.querySelectorAll<HTMLButtonElement>('.overlay-btn');
    overlayButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.overlay === mode);
    });

    this.updateInstanceColors();
  }

  public toggleInvertMode(): void {
    if (this.heightMode === 'binding') {
      // Switch to Inverted Mode: Height represents Half-Life, Color represents Binding Energy
      this.heightMode = 'halflife';
      this.colorOverlay = 'binding';

      if (this.toggleInvertBtn) this.toggleInvertBtn.classList.add('active');
      if (this.invertBtnText) this.invertBtnText.textContent = 'Height: Half-Life (Inverted)';
      if (this.btnOverlayVar) {
        this.btnOverlayVar.textContent = 'Binding Energy Heatmap';
        this.btnOverlayVar.dataset.overlay = 'binding';
        this.btnOverlayVar.title = 'Thermal camera heatmap of binding energy per nucleon (Cold: Most Bound / Fe-56, Hot: Weakly Bound)';
      }
      if (this.appSubtitle) {
        this.appSubtitle.textContent = '3D Half-Life Landscape — Stability Canyon (Inverted Mode: Height = Half-Life, Color = Binding Energy)';
      }
    } else {
      // Switch back to Standard Mode: Height represents Binding Energy, Color represents Half-Life
      this.heightMode = 'binding';
      this.colorOverlay = 'halflife';

      if (this.toggleInvertBtn) this.toggleInvertBtn.classList.remove('active');
      if (this.invertBtnText) this.invertBtnText.textContent = 'Invert Height & Color';
      if (this.btnOverlayVar) {
        this.btnOverlayVar.textContent = 'Half-Life Heatmap';
        this.btnOverlayVar.dataset.overlay = 'halflife';
        this.btnOverlayVar.title = 'Thermal camera heatmap of nuclear half-life (Cold: Long t½ / Stable, Hot: Short t½)';
      }
      if (this.appSubtitle) {
        this.appSubtitle.textContent = '3D Binding Energy Landscape — Valley of Stability (Logarithmic Canyon)';
      }
    }

    // Update active state on overlay buttons
    const overlayButtons = document.querySelectorAll<HTMLButtonElement>('.overlay-btn');
    overlayButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.overlay === this.colorOverlay);
    });

    // Recompute heights and colors
    this.updateInstanceTransforms();
    this.updateInstanceColors();
  }

  public toggleMagicNumbers(): void {
    this.showMagicNumbers = !this.showMagicNumbers;
    if (this.magicLinesMesh) this.magicLinesMesh.visible = this.showMagicNumbers;
    if (this.magicBoxMesh) this.magicBoxMesh.visible = this.showMagicNumbers;
    if (this.toggleMagicBtn) {
      this.toggleMagicBtn.classList.toggle('active', this.showMagicNumbers);
    }
  }

  public setScaleMode(mode: ElevationScaleMode): void {
    if (this.scaleMode === mode) return;
    this.scaleMode = mode;

    // Update active UI button style
    const scaleButtons = document.querySelectorAll<HTMLButtonElement>('.scale-btn');
    scaleButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scale === mode);
    });

    // Recompute all 3D column and top-cap heights
    this.updateInstanceTransforms();

    // If elevation heatmap is active, recompute colors for new elevation range
    if (this.colorOverlay === 'elevation') {
      this.updateInstanceColors();
    }

    // Refresh HUD / highlight box if an isotope is actively hovered
    if (this.hoveredInstanceId !== null) {
      this.updateHudAndHighlight(this.hoveredInstanceId);
    }
  }

  public setHeightMagnification(mag: number): void {
    if (isNaN(mag)) return;
    this.heightMagnification = Math.max(0.5, Math.min(5.0, mag));

    // Recompute all 3D column and top-cap heights
    this.updateInstanceTransforms();

    // If elevation heatmap is active, recompute colors
    if (this.colorOverlay === 'elevation') {
      this.updateInstanceColors();
    }

    // Refresh HUD / highlight box if an isotope is actively hovered
    if (this.hoveredInstanceId !== null) {
      this.updateHudAndHighlight(this.hoveredInstanceId);
    }
  }

  private async loadNuclideData(): Promise<void> {
    try {
      const resp = await fetch('/data/nuclides.json');
      if (!resp.ok) {
        throw new Error(`Failed to load nuclides.json: status ${resp.status}`);
      }
      const rawData: Nuclide[] = await resp.json();
      // Exclude nuclides with Z > 20 and no / 0 binding energy
      this.nuclides = rawData.filter((n) => !(n.Z > 20 && (!n.binding_mev || n.binding_mev <= 0.0001)));
      if (this.statsBadge) {
        this.statsBadge.textContent = `${this.nuclides.length.toLocaleString()} ground-state nuclides loaded (IAEA LiveChart)`;
      }
      this.buildNuclideLandscape();
    } catch (err) {
      console.error('Error loading nuclide data:', err);
      if (this.statsBadge) {
        this.statsBadge.textContent = 'Error loading dataset. Check console.';
      }
    }
  }

  private getDecayModeInfo(nuclide: Nuclide): { color: THREE.Color; label: string } {
    if (nuclide.is_stable) {
      return {
        color: new THREE.Color(0x22262e), // Stable: Obsidian / Charcoal
        label: 'STABLE'
      };
    }

    if (nuclide.decay_modes && nuclide.decay_modes.length > 0) {
      const primary = nuclide.decay_modes[0];
      const m = (primary.mode || '').toUpperCase();
      const pct = (primary.fraction * 100).toFixed(0);

      if (m.startsWith('A')) {
        return { color: new THREE.Color(0xd62728), label: `&alpha; (${pct}%)` };
      }
      if (m.includes('SF')) {
        return { color: new THREE.Color(0x22c55e), label: `SF (${pct}%)` };
      }
      if (m.startsWith('B-')) {
        return { color: new THREE.Color(0x1f77b4), label: `&beta;&minus; (${pct}%)` };
      }
      if (m.startsWith('B+') || m.startsWith('EC') || m.startsWith('2EC') || m.startsWith('2B+')) {
        return { color: new THREE.Color(0xff7f0e), label: `&beta;+ / EC (${pct}%)` };
      }
      if (m.startsWith('P')) {
        return { color: new THREE.Color(0x9333ea), label: `Proton (${pct}%)` };
      }
      if (m.startsWith('N')) {
        return { color: new THREE.Color(0x06b6d4), label: `Neutron (${pct}%)` };
      }
      return { color: new THREE.Color(0x38bdf8), label: `${primary.mode} (${pct}%)` };
    }

    return { color: new THREE.Color(0x64748b), label: 'Unknown' };
  }

  private getThermalColor(t: number): THREE.Color {
    t = Math.max(0, Math.min(1, t));

    // Thermal camera colormap (FLIR Ironbow / Inferno):
    // 0.00: Cold Obsidian / Deep Black:   #06020c
    // 0.25: Deep Thermal Purple:          #4c0a75
    // 0.50: Flame Crimson / Hot Red:      #d9251d
    // 0.75: Solar Radiant Yellow:         #f8d228
    // 1.00: Incandescent Thermal White:   #ffffff
    let r = 0, g = 0, b = 0;

    if (t <= 0.25) {
      const f = t / 0.25;
      r = 0.024 + f * (0.298 - 0.024);
      g = 0.008 + f * (0.039 - 0.008);
      b = 0.047 + f * (0.459 - 0.047);
    } else if (t <= 0.50) {
      const f = (t - 0.25) / 0.25;
      r = 0.298 + f * (0.851 - 0.298);
      g = 0.039 + f * (0.145 - 0.039);
      b = 0.459 + f * (0.114 - 0.459);
    } else if (t <= 0.75) {
      const f = (t - 0.50) / 0.25;
      r = 0.851 + f * (0.973 - 0.851);
      g = 0.145 + f * (0.824 - 0.145);
      b = 0.114 + f * (0.157 - 0.114);
    } else {
      const f = (t - 0.75) / 0.25;
      r = 0.973 + f * (1.000 - 0.973);
      g = 0.824 + f * (1.000 - 0.824);
      b = 0.157 + f * (1.000 - 0.157);
    }

    return new THREE.Color(r, g, b);
  }

  private getNuclideLogHalfLife(nuclide: Nuclide): number {
    if (nuclide.is_stable || nuclide.half_life === 'STABLE') {
      return this.MAX_LOG_HL;
    }
    if (nuclide.half_life_sec !== null && nuclide.half_life_sec !== undefined && nuclide.half_life_sec > 0) {
      const clampedSec = Math.min(this.TEN_BILLION_YEARS_SEC, nuclide.half_life_sec);
      return Math.max(this.MIN_LOG_HL, Math.log10(clampedSec));
    }
    return this.MIN_LOG_HL;
  }

  private computeColumnHeight(nuclide: Nuclide): number {
    const floor = 0.25;
    let deltaVal: number;

    if (this.heightMode === 'binding') {
      // Standard Mode: Inverted Valley of Stability
      // Stable Fe-56 (8.79 MeV) forms the deep canyon floor (height = 0.25)
      // Weakly bound nuclei rise up to form the canyon walls
      deltaVal = Math.max(0, this.MAX_BINDING - nuclide.binding_mev);
    } else {
      // Inverted Mode: Height represents log half-life
      // Stable nuclei / long half-lives form the canyon floor (height = 0.25)
      // Short half-lives / prompt drip-line nuclei tower up as canyon walls
      const logHL = this.getNuclideLogHalfLife(nuclide);
      const t_hl = (this.MAX_LOG_HL - logHL) / (this.MAX_LOG_HL - this.MIN_LOG_HL);
      deltaVal = t_hl * 8.79;
    }

    let baseHeight: number;
    switch (this.scaleMode) {
      case 'log':
        // Shifted logarithmic scale:
        // Greatly expands subtle differences across isotopic chains
        // while gracefully compressing extremes so they don't dominate.
        baseHeight = floor + Math.log(1.0 + 4.0 * deltaVal) * 5.5;
        break;

      case 'sqrt':
        // Sub-linear fractional power scale: gentle intermediate compression
        baseHeight = floor + Math.sqrt(deltaVal) * 6.0;
        break;

      case 'linear':
      default:
        // Pure uncompressed linear elevation
        baseHeight = floor + deltaVal * 1.6;
        break;
    }

    return baseHeight * this.heightMagnification;
  }

  private getNuclideColor(nuclide: Nuclide, minHeight: number, maxHeight: number): THREE.Color {
    if (this.colorOverlay === 'decay') {
      return this.getDecayModeInfo(nuclide).color;
    }

    if (this.colorOverlay === 'halflife') {
      // Long half-lives are cold (black/purple), short half-lives are hot (yellow/white)
      const logHL = this.getNuclideLogHalfLife(nuclide);
      const t = (this.MAX_LOG_HL - logHL) / (this.MAX_LOG_HL - this.MIN_LOG_HL);
      return this.getThermalColor(t);
    }

    if (this.colorOverlay === 'elevation') {
      // Low elevation is cold, high is hot
      const colH = this.computeColumnHeight(nuclide);
      const range = maxHeight - minHeight;
      const t = range > 0.0001 ? (colH - minHeight) / range : 0;
      return this.getThermalColor(t);
    }

    if (this.colorOverlay === 'binding') {
      // Most bound (Fe-56) is cold (canyon floor), weakly bound is hot
      const deltaB = Math.max(0, this.MAX_BINDING - nuclide.binding_mev);
      const t = deltaB / this.MAX_BINDING;
      return this.getThermalColor(t);
    }

    return this.getDecayModeInfo(nuclide).color;
  }

  private updateLegendUI(): void {
    if (!this.legendDecay || !this.legendThermal) return;

    if (this.colorOverlay === 'decay') {
      this.legendDecay.style.display = 'flex';
      this.legendThermal.style.display = 'none';
    } else {
      this.legendDecay.style.display = 'none';
      this.legendThermal.style.display = 'flex';

      if (this.colorOverlay === 'halflife') {
        if (this.thermalColdLabel && this.thermalHotLabel) {
          this.thermalColdLabel.textContent = 'Stable';
          this.thermalHotLabel.textContent = 'Hot (~10⁻²² s)';
        }
        if (this.thermalTicksRow) {
          this.thermalTicksRow.innerHTML = `
            <span class="tick-label tick-start" title="Stable isotopes: mathematically smoothed at 10 billion years">Stable</span>
            <span class="tick-label" style="left: 25%" title="1 year">1 yr</span>
            <span class="tick-label" style="left: 44%" title="1 second">1 s</span>
            <span class="tick-label" style="left: 52%" title="1 millisecond">1 ms</span>
            <span class="tick-label tick-end" style="left: 100%" title="Unbound resonance prompt decay">~10<sup>&minus;22</sup> s</span>
          `;
        }
      } else if (this.colorOverlay === 'binding') {
        if (this.thermalColdLabel && this.thermalHotLabel) {
          this.thermalColdLabel.textContent = 'Most Bound';
          this.thermalHotLabel.textContent = 'Weakly Bound';
        }
        if (this.thermalTicksRow) {
          this.thermalTicksRow.innerHTML = `
            <span class="tick-label tick-start">8.79 MeV (Fe-56)</span>
            <span class="tick-label tick-end" style="left: 100%">0 MeV</span>
          `;
        }
      } else {
        // Elevation heatmap
        const scaleName = this.scaleMode === 'log' ? 'Log Canyon' : (this.scaleMode === 'sqrt' ? 'Power' : 'Linear');
        if (this.thermalColdLabel && this.thermalHotLabel) {
          this.thermalColdLabel.textContent = `Floor (0.25, ${scaleName})`;
          this.thermalHotLabel.textContent = `Peak (${scaleName})`;
        }
        if (this.thermalTicksRow) {
          this.thermalTicksRow.innerHTML = `
            <span class="tick-label tick-start">0.25 (Floor)</span>
            <span class="tick-label tick-end" style="left: 100%">Max Height</span>
          `;
        }
      }
    }
  }

  private updateInstanceColors(): void {
    if (!this.instancedMesh || !this.capMesh || !this.nuclides.length) return;

    let minHeight = Infinity;
    let maxHeight = -Infinity;
    if (this.colorOverlay === 'elevation') {
      for (let i = 0; i < this.nuclides.length; i++) {
        const h = this.computeColumnHeight(this.nuclides[i]);
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
      }
    }

    for (let i = 0; i < this.nuclides.length; i++) {
      const nuclide = this.nuclides[i];
      const color = this.getNuclideColor(nuclide, minHeight, maxHeight);
      this.instancedMesh.setColorAt(i, color);
      this.capMesh.setColorAt(i, color);
    }

    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
    if (this.capMesh.instanceColor) {
      this.capMesh.instanceColor.needsUpdate = true;
    }

    this.updateLegendUI();
  }

  private updateInstanceTransforms(): void {
    if (!this.instancedMesh || !this.capMesh || !this.nuclides.length) return;

    const baseWidth = 0.85;
    const dummy = new THREE.Object3D();
    const count = this.nuclides.length;

    for (let i = 0; i < count; i++) {
      const nuclide = this.nuclides[i];
      const colHeight = this.computeColumnHeight(nuclide);

      // Setup column body instance matrix
      dummy.position.set(nuclide.N, colHeight / 2, nuclide.Z);
      dummy.scale.set(baseWidth, colHeight, baseWidth);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      this.instancedMesh.setMatrixAt(i, dummy.matrix);

      // Setup top cap instance matrix (sits flush on top face)
      dummy.position.set(nuclide.N, colHeight + 0.002, nuclide.Z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      this.capMesh.setMatrixAt(i, dummy.matrix);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this.capMesh.instanceMatrix.needsUpdate = true;

    this.instancedMesh.computeBoundingBox();
    this.instancedMesh.computeBoundingSphere();
    this.capMesh.computeBoundingBox();
    this.capMesh.computeBoundingSphere();

    // Update magic number outlines and translucent columns
    if (this.magicNuclideIndices.length > 0 && this.magicLinesMesh && this.magicBoxMesh && this.magicPositions) {
      const magicCount = this.magicNuclideIndices.length;
      const mWidth = 0.94;
      const halfW = mWidth / 2;
      const hMargin = 0.08;
      let posIdx = 0;

      for (let m = 0; m < magicCount; m++) {
        const nIdx = this.magicNuclideIndices[m];
        const nuclide = this.nuclides[nIdx];
        const colH = this.computeColumnHeight(nuclide);
        const mHeight = colH + hMargin;

        // Translucent box instance matrix
        dummy.position.set(nuclide.N, mHeight / 2, nuclide.Z);
        dummy.scale.set(mWidth, mHeight, mWidth);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        this.magicBoxMesh.setMatrixAt(m, dummy.matrix);

        // Wireframe line vertices (12 edges = 24 points = 72 floats)
        const x = nuclide.N;
        const z = nuclide.Z;
        const x0 = x - halfW, x1 = x + halfW;
        const z0 = z - halfW, z1 = z + halfW;
        const y0 = 0, y1 = mHeight;

        // Bottom 4 edges
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;

        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;

        // Top 4 edges
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;

        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;

        // Vertical 4 edges
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z0;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z0;

        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x1; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;

        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y0; this.magicPositions[posIdx++] = z1;
        this.magicPositions[posIdx++] = x0; this.magicPositions[posIdx++] = y1; this.magicPositions[posIdx++] = z1;
      }

      this.magicBoxMesh.instanceMatrix.needsUpdate = true;
      this.magicLinesMesh.geometry.attributes.position.needsUpdate = true;
      this.magicLinesMesh.geometry.computeBoundingSphere();
      this.magicBoxMesh.computeBoundingSphere();
    }

    // Recompute elevation colors if elevation heatmap is currently selected
    if (this.colorOverlay === 'elevation') {
      this.updateInstanceColors();
    }

    // Refresh HUD / highlight box if an isotope is actively hovered
    if (this.hoveredInstanceId !== null) {
      this.updateHudAndHighlight(this.hoveredInstanceId);
    }
  }

  private generateTextAtlas(): THREE.CanvasTexture {
    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = 4096;
    atlasCanvas.height = 4096;
    const ctx = atlasCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create 2D canvas context for text atlas');
    }

    ctx.clearRect(0, 0, 4096, 4096);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const count = this.nuclides.length;
    for (let i = 0; i < count; i++) {
      const nuclide = this.nuclides[i];
      const col = i % 64;
      const row = Math.floor(i / 64);
      const x = col * 64;
      const y = row * 64;
      const cx = x + 32;

      // Line 1: Mass number A (e.g. 56 or 238)
      ctx.font = 'bold 20px "Segoe UI", -apple-system, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000';
      ctx.strokeText(`${nuclide.mass}`, cx, y + 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${nuclide.mass}`, cx, y + 20);

      // Line 2: Chemical symbol (e.g. Fe or U)
      ctx.font = 'bold 26px "Segoe UI", -apple-system, sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000';
      ctx.strokeText(nuclide.symbol, cx, y + 44);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(nuclide.symbol, cx, y + 44);
    }

    const texture = new THREE.CanvasTexture(atlasCanvas);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  private buildNuclideLandscape(): void {
    if (!this.nuclides.length) return;

    const count = this.nuclides.length;
    const baseWidth = 0.85; // 0.15 gap between columns

    // 1. Column bodies (InstancedMesh of 1x1x1 boxes)
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const boxMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.15
    });
    this.instancedMesh = new THREE.InstancedMesh(boxGeometry, boxMaterial, count);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 2. Generate text atlas for isotope symbol & mass on top caps
    const atlasTexture = this.generateTextAtlas();

    // 3. Top-cap plane geometry with instanced UV offsets
    const capGeometry = new THREE.PlaneGeometry(baseWidth, baseWidth);
    capGeometry.rotateX(-Math.PI / 2);

    const uvOffsets = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const col = i % 64;
      const row = Math.floor(i / 64);
      uvOffsets[i * 2 + 0] = col / 64.0;
      uvOffsets[i * 2 + 1] = 1.0 - (row + 1) / 64.0;
    }
    capGeometry.setAttribute('aAtlasUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));

    const capMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.35,
      metalness: 0.15
    });

    // Hook shader to sample text atlas and overlay onto the instance color
    capMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uAtlas = { value: atlasTexture };
      shader.vertexShader = `
        attribute vec2 aAtlasUvOffset;
        varying vec2 vAtlasUv;
      ` + shader.vertexShader.replace(
        '#include <uv_vertex>',
        `
        #include <uv_vertex>
        vAtlasUv = uv * (1.0 / 64.0) + aAtlasUvOffset;
        `
      );
      shader.fragmentShader = `
        uniform sampler2D uAtlas;
        varying vec2 vAtlasUv;
      ` + shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        vec4 atlasSample = texture2D(uAtlas, vAtlasUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, atlasSample.rgb, atlasSample.a);
        `
      );
    };

    this.capMesh = new THREE.InstancedMesh(capGeometry, capMaterial, count);
    this.capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 4. Magic number outlines and translucent box instanced mesh
    this.magicNuclideIndices = [];
    for (let i = 0; i < count; i++) {
      const n = this.nuclides[i];
      if (MAGIC_Z.has(n.Z) || MAGIC_N.has(n.N)) {
        this.magicNuclideIndices.push(i);
      }
    }

    const magicCount = this.magicNuclideIndices.length;
    if (magicCount > 0) {
      // Line segments geometry for magic edges (24 vertices = 72 floats per box)
      this.magicPositions = new Float32Array(magicCount * 72);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(this.magicPositions, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
        depthWrite: false
      });
      this.magicLinesMesh = new THREE.LineSegments(lineGeo, lineMat);
      this.magicLinesMesh.renderOrder = 3;
      this.scene.add(this.magicLinesMesh);

      // Translucent white box instanced mesh
      const magicBoxGeo = new THREE.BoxGeometry(1, 1, 1);
      const magicBoxMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.10,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this.magicBoxMesh = new THREE.InstancedMesh(magicBoxGeo, magicBoxMat, magicCount);
      this.magicBoxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.magicBoxMesh.renderOrder = 2;
      this.scene.add(this.magicBoxMesh);
    }

    // Apply colors to all instances
    this.updateInstanceColors();

    // Set initial 3D positions and heights based on current scaleMode
    this.updateInstanceTransforms();

    this.scene.add(this.instancedMesh);
    this.scene.add(this.capMesh);
  }


  private handleKeyboardMovement(delta: number): void {
    // Movement speed: 40 units/sec, with Shift boost 95 units/sec
    const isShift = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const speed = (isShift ? 95 : 40) * delta;

    // Horizontal forward & right vectors (in XZ plane) derived purely from yaw:
    // This guarantees 100% reliable movement at 45°, 90°, or any camera angle without hesitation
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();

    const move = new THREE.Vector3();

    // W / ArrowUp: Forward
    if (this.keys['KeyW'] || this.keys['ArrowUp']) {
      move.add(forward);
    }
    // S / ArrowDown: Backward
    if (this.keys['KeyS'] || this.keys['ArrowDown']) {
      move.sub(forward);
    }
    // D / ArrowRight: Strafe Right
    if (this.keys['KeyD'] || this.keys['ArrowRight']) {
      move.add(right);
    }
    // A / ArrowLeft: Strafe Left
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) {
      move.sub(right);
    }
    // Space / E: Fly Up (Ascend)
    if (this.keys['Space'] || this.keys['KeyE']) {
      move.y += 1;
    }
    // Ctrl / C / Q: Fly Down (Descend towards ground)
    if (
      this.keys['ControlLeft'] ||
      this.keys['ControlRight'] ||
      this.keys['KeyC'] ||
      this.keys['KeyQ']
    ) {
      move.y -= 1;
    }

    if (move.lengthSq() > 0.0001) {
      move.normalize();
      this.camera.position.addScaledVector(move, speed);
    }
  }

  private updateHudAndHighlight(id: number): void {
    const nuclide = this.nuclides[id];
    if (!nuclide) return;

    const colHeight = this.computeColumnHeight(nuclide);
    const decayInfo = this.getDecayModeInfo(nuclide);
    const deltaB = Math.max(0, this.MAX_BINDING - nuclide.binding_mev);

    // Update HUD
    if (this.hudTitle && this.hudDetails) {
      const stabilityText = nuclide.is_stable ? 'STABLE' : `t½: ${nuclide.half_life}`;
      const scaleLabel = this.scaleMode === 'log'
        ? 'Log Canyon'
        : (this.scaleMode === 'sqrt' ? 'Power √Δ' : 'Linear');

      const magSuffix = Math.abs(this.heightMagnification - 1.0) > 0.001
        ? `, ${this.heightMagnification.toFixed(2)}x`
        : '';

      let elevationInfo: string;
      if (this.heightMode === 'binding') {
        const isFloor = deltaB < 0.05;
        elevationInfo = isFloor
          ? '<span style="color:#38bdf8;font-weight:600;">Canyon Floor (Most Bound)</span>'
          : `Cliff Elevation: +${(colHeight - 0.25 * this.heightMagnification).toFixed(2)} units (${scaleLabel}${magSuffix})`;
      } else {
        const isFloor = nuclide.is_stable || nuclide.half_life === 'STABLE';
        elevationInfo = isFloor
          ? '<span style="color:#38bdf8;font-weight:600;">Canyon Floor (Stable, t½ = ∞)</span>'
          : `Cliff Elevation: +${(colHeight - 0.25 * this.heightMagnification).toFixed(2)} units (${scaleLabel}${magSuffix})`;
      }

      const isZMagic = MAGIC_Z.has(nuclide.Z);
      const isNMagic = MAGIC_N.has(nuclide.N);
      let magicTag = '';
      if (isZMagic && isNMagic) {
        magicTag = `<div class="magic-indicator-tag double-magic">🌟 Doubly Magic Nucleus (Z=${nuclide.Z}, N=${nuclide.N})</div>`;
      } else if (isZMagic) {
        magicTag = `<div class="magic-indicator-tag">✨ Magic Proton Number (Z=${nuclide.Z})</div>`;
      } else if (isNMagic) {
        magicTag = `<div class="magic-indicator-tag">✨ Magic Neutron Number (N=${nuclide.N})</div>`;
      }

      this.hudTitle.textContent = `${nuclide.id} (${nuclide.symbol})`;
      this.hudDetails.innerHTML = `
        <strong>Protons (Z):</strong> ${nuclide.Z} &nbsp;|&nbsp;
        <strong>Neutrons (N):</strong> ${nuclide.N} &nbsp;|&nbsp;
        <strong>Mass (A):</strong> ${nuclide.mass}<br>
        <strong>Binding Energy:</strong> ${nuclide.binding_mev.toFixed(3)} MeV/nucleon ${this.heightMode === 'binding' ? `(${elevationInfo})` : ''}<br>
        <strong>Primary Mode:</strong> ${decayInfo.label} &nbsp;|&nbsp;
        <strong>Half-life:</strong> ${stabilityText} ${this.heightMode === 'halflife' ? `(${elevationInfo})` : ''}
        ${magicTag}
      `;
    }

    // Position highlight wireframe box on active isotope column
    if (this.highlightBox) {
      this.highlightBox.position.set(nuclide.N, colHeight / 2, nuclide.Z);
      this.highlightBox.scale.set(0.98, colHeight + 0.05, 0.98);
      this.highlightBox.visible = true;
    }
  }

  private updateRaycasting(): void {
    // Avoid recomputing hover highlights while dragging the camera
    if (this.isDragging || !this.instancedMesh || !this.nuclides.length) return;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    // Raycast against both column body and top cap
    const targets = this.capMesh ? [this.instancedMesh, this.capMesh] : [this.instancedMesh];
    const intersects = this.raycaster.intersectObjects(targets);

    if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
      const id = intersects[0].instanceId;
      if (id !== this.hoveredInstanceId) {
        this.hoveredInstanceId = id;
        this.updateHudAndHighlight(id);
      }
    } else {
      if (this.hoveredInstanceId !== null) {
        this.hoveredInstanceId = null;
        if (this.highlightBox) {
          this.highlightBox.visible = false;
        }
      }
    }
  }

  private onWindowResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const delta = this.clock.getDelta();

    // Handle WASD, Arrows, Space, Ctrl, C flight navigation
    this.handleKeyboardMovement(delta);

    // Raycast hover detection (when not dragging)
    this.updateRaycasting();

    // Render frame
    this.renderer.render(this.scene, this.camera);
  };
}

// Bootstrap application on DOM load
window.addEventListener('DOMContentLoaded', () => {
  new NuclideApp();
});

