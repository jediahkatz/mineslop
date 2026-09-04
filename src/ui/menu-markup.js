const controls = [
  ["W A S D", "Move"],
  ["Mouse", "Look", "look"],
  ["Space", "Jump / swim up"],
  ["Ctrl / W ×2", "Sprint"],
  ["Shift", "Sneak / descend"],
  ["Space ×2", "Toggle Creative flight"],
  ["LMB", "Mine / attack"],
  ["RMB", "Place / use / hold to eat", "use"],
  ["MMB", "Pick block"],
  ["1–9 / Wheel", "Select hotbar slot"],
  ["E", "Inventory"],
  ["F", "Swap hands"],
  ["Q / Ctrl+Q", "Drop item / stack"],
  ["F1", "Show / hide HUD"],
  ["F3", "Debug information"],
  ["F5", "Change perspective"],
  ["Esc", "Game menu / close screen"],
  ["B", "World atlas (Mineslop)"],
  ["P", "Save world (Mineslop)"],
];

function fullscreenSettings(page) {
  const id =
    page === "video" ? "fullscreen-setting" : "controls-fullscreen-setting";
  return `
    <div class="fullscreen-settings">
      <button type="button" id="${id}" class="fullscreen-toggle" data-fullscreen-toggle aria-pressed="false" aria-describedby="${page}-fullscreen-status ${page}-shortcut-warning ${page}-fullscreen-help">Fullscreen: OFF</button>
      <p id="${page}-fullscreen-status" class="fullscreen-status settings-note" data-fullscreen-state role="status" aria-live="polite">Game fullscreen off · Shortcuts not captured</p>
      <p id="${page}-shortcut-warning" class="settings-note shortcut-warning">Windowed browser shortcuts such as <kbd>Ctrl+W</kbd> can close this tab. Double-tap <kbd>W</kbd> to sprint safely.</p>
      <p id="${page}-fullscreen-help" class="settings-note">This game's button enters API fullscreen and captures game shortcuts when supported; browser <kbd>F11</kbd> alone does not capture them. In captured fullscreen, tap <kbd>Esc</kbd> to pause. The browser always lets you <kbd>HOLD Esc</kbd> to exit fullscreen.</p>
    </div>`;
}

export function menuMarkup() {
  return `
    <section class="menu-screen" hidden aria-label="Main menu" tabindex="-1">
      <div class="title-copy"><h1>MINESLOP</h1><span class="edition-label">BROWSER EDITION</span></div>
      <h2 class="menu-title" hidden>Game Menu</h2>
      <div class="menu-pages">
        <section class="main-menu-stack" data-menu-page="main">
          <button class="play-button"><span class="play-label">Play World</span></button>
          <button class="world-settings-button" data-menu-target="world">World...</button>
          <button class="settings-toggle" data-menu-target="options" aria-expanded="false" aria-controls="world-settings">Options...</button>
          <button class="save-and-quit-button" hidden>Save and Quit to Title</button>
          <p class="single-world-note">One world is stored in this browser.</p>
        </section>
        <div id="world-settings" class="settings-panel" hidden>
          <section class="menu-page options-page" data-menu-page="options" hidden>
            <div class="menu-button-grid">
              <button class="controls-settings-button" data-menu-target="controls">Controls...</button>
              <button class="video-settings-button" data-menu-target="video">Video Settings...</button>
              <button data-menu-target="world">World Settings...</button>
              <label class="setting-row sound-row" for="sound-setting"><span>World Sounds</span><input type="checkbox" id="sound-setting" checked></label>
            </div>
            <p class="settings-note">Controls and GUI scale stay in this browser.</p>
          </section>
          <section class="menu-page controls-page" data-menu-page="controls" hidden>
            <label class="setting-row" for="input-mode-setting"><span>Mouse Input</span><select id="input-mode-setting" aria-describedby="input-mode-help"><option value="native">Native (captured)</option><option value="remote">Remote (drag look)</option></select></label>
            <p id="input-mode-help" class="input-mode-help"></p>
            <label class="range-setting" for="mouse-sensitivity-setting"><span>Mouse Sensitivity <output id="mouse-sensitivity-value" for="mouse-sensitivity-setting">1.00×</output></span><input type="range" id="mouse-sensitivity-setting" value="1" aria-describedby="control-preferences-note"></label>
            <p id="control-preferences-note" class="settings-note">Native is recommended for local play. Remote supports streamed desktops.</p>
            ${fullscreenSettings("controls")}
            <div class="controls-guide" aria-label="Keyboard controls">${controls.map(([key, label, control]) => `<div class="control-item"${control ? ` data-control="${control}"` : ""}><span>${label}</span><kbd>${key}</kbd></div>`).join("")}<div class="control-item remote-held-use" hidden><span>Hold use / eat / bow / shield (Remote)</span><kbd>V</kbd></div></div>
          </section>
          <section class="menu-page video-page" data-menu-page="video" hidden>
            <label class="setting-row" for="quality-setting"><span>Graphics</span><select id="quality-setting"><option value="low">Fast</option><option value="medium">Balanced</option><option value="high">Fancy</option></select></label>
            <label class="setting-row" for="show-fps-setting"><span>Show FPS</span><input type="checkbox" id="show-fps-setting" aria-describedby="show-fps-help"></label>
            <p id="show-fps-help" class="settings-note">Small frame-rate counter. Updates twice a second; stays in this browser.</p>
            <label class="setting-row" for="gui-scale-setting"><span>GUI Scale</span><select id="gui-scale-setting" aria-describedby="gui-scale-help"><option value="auto">Auto</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
            <p id="gui-scale-help" class="settings-note">The interface is capped to fit the window. This does not change render quality.</p>
            ${fullscreenSettings("video")}
            <label class="setting-row" for="fullbright-inspection-setting"><span>Fullbright Inspection</span><input type="checkbox" id="fullbright-inspection-setting" aria-describedby="fullbright-inspection-help"></label>
            <p id="fullbright-inspection-help" class="input-mode-help">Inspection only: lights every block face without changing time or placed lights. Stays in this browser, not world saves.</p>
          </section>
          <section class="menu-page world-page" data-menu-page="world" hidden>
            <p class="world-summary">Seed: <strong class="world-seed-value">cedar-valley</strong><span class="mode-label">Survival</span></p>
            <div class="mode-picker" role="group" aria-label="Game mode"><button type="button" data-mode="survival" aria-pressed="true">Survival</button><button type="button" data-mode="creative" aria-pressed="false">Creative</button></div>
            <label class="setting-row" for="dimension-setting"><span>Dimension</span><select id="dimension-setting"><option value="overworld">Overworld</option><option value="nether">Nether</option><option value="end">The End</option></select></label>
            <p class="settings-note survival-travel-note">In Survival, travel between dimensions through portals.</p>
            <label class="range-setting" for="time-setting"><span>Time of Day <strong class="settings-time-label">Daylight</strong></span><input type="range" id="time-setting" min="0" max="1" step="0.005" value="0.3"></label>
            <div class="menu-button-grid world-actions">
              <button class="save-button">Save World</button><button class="export-button">Export Save...</button>
              <button class="import-button">Import Save...</button><button data-menu-target="new-world" class="new-world-button">Create New World...</button>
            </div>
            <button class="spawn-button" data-creative-only hidden>Return to Spawn</button>
            <p class="settings-note">One stored world. Importing or generating replaces it after confirmation. Export a backup first.</p>
            <input class="import-file" type="file" accept=".json,application/json" aria-label="Import a Mineslop save file" hidden>
          </section>
          <section class="menu-page new-world-page" data-menu-page="new-world" hidden>
            <p class="world-replace-warning">This browser stores one world. A new world replaces the current one. Export your save first to keep it.</p>
            <form class="seed-form">
              <label for="world-seed">Seed for the World Generator</label>
              <input id="world-seed" name="seed" value="cedar-valley" maxlength="80" autocomplete="off" spellcheck="false">
              <div class="setting-row"><label for="world-generation">World Generation</label><select id="world-generation" name="generatorVersion" aria-describedby="world-generation-help"><option value="3" selected>Classic (default)</option><option value="7">Expanded (experimental)</option></select></div>
              <p id="world-generation-help" class="settings-note">Expanded: deeper Overworld, new biomes and structures. Visual acceptance is unfinished. Applies only to this new world; loading or importing a save preserves its original terrain.</p>
              <p class="terrain-generation-note" hidden>Your existing world's original terrain is preserved. Choose the generation for a new world explicitly.</p>
              <button type="submit" class="generate-button danger-button">Generate and Replace World...</button>
            </form>
          </section>
          <button class="menu-back-button">Done</button>
        </div>
      </div>
      <p class="storage-status" role="status" aria-live="polite">Saves stay on this device. Export a backup to keep.</p>
      <footer class="title-footer"><span>Mineslop · Original voxel sandbox</span><span class="footer-world">Seed: <b>cedar-valley</b></span></footer>
    </section>`;
}
