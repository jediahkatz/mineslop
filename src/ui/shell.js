import { menuMarkup } from "./menu-markup.js";

export function shellMarkup() {
  return `
    <section class="game-hud" hidden aria-label="Game interface">
      <div class="debug-overlay" hidden>
        <div class="hud-location">
          <div class="debug-line">Voxelcraft (browser edition) · <span class="creative-badge">Survival</span></div>
          <div class="debug-line"><span class="fps-indicator"></span> · <span class="chunk-count"></span></div>
          <div class="coordinates debug-line">XYZ: <b data-coordinate="x">0</b> / <b data-coordinate="y">0</b> / <b data-coordinate="z">0</b></div>
          <div class="debug-line">Dimension: <span class="hud-dimension">Overworld</span></div>
          <button class="hud-biome debug-line" aria-label="Open world atlas">Biome: <span data-biome-name>Unknown</span></button>
          <div class="debug-line">Time: <span data-time-label>Daylight</span></div>
          <div class="target-label debug-line" hidden></div>
          <div class="flight-indicator debug-line" hidden>Flying · Space: up · Shift: down · Double-Space: land</div>
          <button class="hud-pause">Pause Game</button>
        </div>
        <span class="debug-help">F3: hide debug · B: Voxelcraft atlas · P: save</span>
      </div>
      <div class="crosshair" aria-hidden="true"></div>
      <div class="mining-progress sr-only" role="progressbar" aria-label="Mining progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-live="off" hidden></div>
      <div class="remote-input-hints" hidden><div class="hotbar-hint"><span class="hotbar-look-hint" hidden><kbd>RIGHT-DRAG</kbd> Look</span><span class="hotbar-use-hint"><kbd>RMB</kbd> Place / use</span><span><kbd>V</kbd> Hold use / eat / bow / shield</span></div><div class="hotbar-edge-hint" hidden>Remote input · Release and reposition at window edges · Aim with the crosshair</div></div>
      <div class="hotbar-area">
        <div class="spawn-grace" role="timer" aria-live="off" title="Mobs leave you alone briefly. Attacking ends protection. Falls, lava and other hazards still hurt." hidden></div>
        <div class="selected-block-name" aria-live="polite"></div>
        <div class="survival-vitals" hidden>
          <div class="vital-meter armor-meter" role="img" hidden><div class="vital-pips" data-vital="armor"></div></div>
          <div class="vital-meter air-meter" role="img" hidden><div class="vital-pips" data-vital="air"></div></div>
          <div class="vital-meter health-meter" role="img"><div class="vital-pips" data-vital="health"></div></div>
          <div class="vital-meter hunger-meter" role="img"><div class="vital-pips" data-vital="hunger"></div></div>
        </div>
        <div class="experience-meter" hidden><span class="experience-level"></span><div class="experience-track" role="progressbar" aria-label="Experience" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="experience-fill"></span></div></div>
        <div class="hud-offhand" hidden></div>
        <div class="hotbar" role="toolbar" aria-label="Item hotbar"></div>
      </div>
    </section>
    ${menuMarkup()}
    <section class="inventory-overlay" hidden aria-label="Inventory and crafting" tabindex="-1"></section>
    <section class="atlas-overlay" hidden aria-label="World atlas" tabindex="-1"></section>
    <section class="death-overlay" hidden tabindex="-1">
      <div class="death-panel" role="alertdialog" aria-modal="true" aria-labelledby="death-title" aria-describedby="death-description" tabindex="-1">
        <h2 id="death-title">You Died!</h2><p id="death-description"></p>
        <p class="death-reassurance">Keep Inventory is enabled in Voxelcraft. Your items are kept.</p>
        <button class="respawn-button">Respawn</button>
        <button class="death-quit-button">Title Screen</button>
      </div>
    </section>
    <span id="fullbright-inspection-badge" class="inspection-indicator" title="Visual-only biome inspection lighting is enabled" hidden>Fullbright Inspection</span>
    <div class="toast" role="status" aria-live="polite" hidden><span></span></div>
    <section class="loading-screen" aria-label="Loading world"><h2>Loading World</h2><p class="loading-label">Preparing terrain...</p><div class="loading-track" role="progressbar" aria-label="World generation" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div></div></div><span class="loading-percent">0%</span></section>
  `;
}
