import { BIOMES } from "../biomes.js";
import { element, setText, svg } from "./dom.js";
import { dimensionName, filterBiomes } from "./model.js";

export function createAtlas(container, { listen, onClose, onTravel }) {
  let currentBiome;
  let currentDimension = "overworld";
  let creative = false;
  let travelling = false;
  let disposed = false;
  container.innerHTML = `
    <div class="atlas-panel pixel-panel" role="dialog" aria-modal="true" aria-labelledby="atlas-title" tabindex="-1">
      <header class="inventory-header">
        <div><h2 id="atlas-title">World Atlas</h2><p>Mineslop extension · Biome browser and Creative travel</p></div>
        <button class="icon-button atlas-close" aria-label="Close world atlas">${svg("close")}</button>
      </header>
      <div class="atlas-current"><span class="atlas-current-label">Exploring the Overworld</span></div>
      <div class="atlas-tools">
        <label class="search-field">${svg("search")}<input class="atlas-search" type="search" placeholder="Find a biome, landscape or material…" aria-label="Search all biomes" autocomplete="off"></label>
        <select class="atlas-dimension-filter" aria-label="Filter biomes by dimension"><option value="all">All dimensions</option><option value="overworld">Overworld</option><option value="nether">Nether</option><option value="end">The End</option></select>
        <select class="atlas-category-filter" aria-label="Filter biomes by category"><option value="all">Every landscape</option></select>
      </div>
      <div class="atlas-results-label"><span class="atlas-result-count"></span></div>
      <div class="atlas-results"></div>
      <p class="atlas-empty" hidden>No landscapes match. Try a different search or filter.</p>
      <p class="atlas-status" role="status" aria-live="polite" hidden></p>
      <footer class="inventory-footer"><span class="atlas-help">Browse every landscape. Switch to Creative in World Settings to travel.</span><span><kbd>E</kbd> / <kbd>B</kbd> / <kbd>Esc</kbd> Close</span></footer>
    </div>
  `;
  const $ = (selector) => container.querySelector(selector);
  const results = $(".atlas-results");
  const categories = [
    ...new Set(BIOMES.map((biome) => biome.category).filter(Boolean)),
  ].sort();
  for (const category of categories) {
    const option = element(
      "option",
      "",
      category
        .replaceAll("_", " ")
        .replace(/^\w/, (letter) => letter.toUpperCase())
    );
    option.value = category;
    $(".atlas-category-filter").append(option);
  }

  function updateCurrent() {
    const id =
      typeof currentBiome === "string" ? currentBiome : currentBiome?.id;
    const name =
      typeof currentBiome === "string"
        ? BIOMES.find((biome) => biome.id === id)?.name || currentBiome
        : currentBiome?.name;
    setText(
      $(".atlas-current-label"),
      name
        ? `${name} · ${dimensionName(currentDimension)}`
        : `Exploring ${dimensionName(currentDimension)}`
    );
    results.querySelectorAll("[data-biome]").forEach((row) => {
      const current =
        row.dataset.biome === id && row.dataset.dimension === currentDimension;
      row.classList.toggle("is-current", current);
      row.querySelector(".biome-current").hidden = !current;
    });
  }

  function updateTravelControls() {
    results.querySelectorAll("[data-travel]").forEach((button) => {
      button.disabled = !onTravel || !creative || travelling;
      button.title = !onTravel
        ? "Biome travel is unavailable"
        : !creative
          ? "Switch to Creative mode in World Settings to travel"
          : "Find this biome in your world";
    });
    setText(
      $(".atlas-help"),
      creative
        ? "Travel searches your seed for the biome. Your builds stay where you left them."
        : "Browse every landscape. Switch to Creative in World Settings to travel."
    );
  }

  function render() {
    const groups = filterBiomes(BIOMES, {
      query: $(".atlas-search").value,
      dimension: $(".atlas-dimension-filter").value,
      category: $(".atlas-category-filter").value,
    });
    results.replaceChildren();
    const count = groups.reduce(
      (total, group) => total + group.biomes.length,
      0
    );
    setText(
      $(".atlas-result-count"),
      `${count} ${count === 1 ? "biome" : "biomes"}`
    );
    $(".atlas-empty").hidden = count > 0;
    for (const group of groups) {
      const section = element("section", "atlas-group");
      section.setAttribute("aria-label", `${group.name} biomes`);
      const heading = element("h3", "atlas-group-heading", group.name);
      heading.append(element("span", "", group.biomes.length));
      const list = element("div", "atlas-biome-list");
      for (const biome of group.biomes) {
        const card = element("article", "biome-card");
        card.dataset.biome = biome.id;
        card.dataset.dimension = biome.dimension;
        card.style.setProperty(
          "--biome-color",
          biome.color || biome.grassColor || "#859a70"
        );
        const swatch = element("span", "biome-swatch");
        swatch.setAttribute("aria-hidden", "true");
        const copy = element("div", "biome-copy");
        const title = element("div", "biome-title");
        const current = element("span", "biome-current", "YOU ARE HERE");
        current.hidden = true;
        title.append(element("h4", "", biome.name), current);
        copy.append(
          title,
          element(
            "span",
            "biome-category",
            String(biome.category || biome.dimension).replaceAll("_", " ")
          ),
          element("p", "", biome.description || "")
        );
        const button = element("button", "biome-travel");
        button.dataset.travel = biome.id;
        button.innerHTML = `Travel ${svg("arrow")}`;
        button.setAttribute(
          "aria-label",
          `Travel to ${biome.name} in ${group.name}`
        );
        card.append(swatch, copy, button);
        list.append(card);
      }
      section.append(heading, list);
      results.append(section);
    }
    updateCurrent();
    updateTravelControls();
  }

  listen($(".atlas-close"), "click", onClose);
  listen($(".atlas-search"), "input", render);
  listen($(".atlas-dimension-filter"), "change", render);
  listen($(".atlas-category-filter"), "change", render);
  listen(results, "click", async (event) => {
    const button = event.target.closest("[data-travel]");
    if (!button || button.disabled || travelling || !onTravel) return;
    const biome = BIOMES.find((entry) => entry.id === button.dataset.travel);
    if (!biome) return;
    travelling = true;
    const status = $(".atlas-status");
    status.hidden = false;
    status.dataset.state = "busy";
    setText(status, `Finding ${biome.name} in your world…`);
    container.setAttribute("aria-busy", "true");
    results.querySelectorAll("[data-travel]").forEach((control) => {
      control.disabled = true;
    });
    try {
      const result = await onTravel(biome.id);
      if (disposed) return;
      if (result === false || result === null || result?.ok === false)
        throw new Error(
          result?.message ||
            "No safe location was found. Try again from another part of your world."
        );
      if (result === undefined) {
        setText(
          status,
          "Travel requested. Your world will open when it is ready."
        );
        status.dataset.state = "idle";
        return;
      }
      setText(status, `Arrived at ${biome.name}.`);
      status.dataset.state = "success";
      onClose();
    } catch (error) {
      if (disposed) return;
      setText(
        status,
        error.message ||
          "Could not reach this biome. Your current world is unchanged."
      );
      status.dataset.state = "error";
    } finally {
      travelling = false;
      if (!disposed) {
        container.setAttribute("aria-busy", "false");
        updateTravelControls();
      }
    }
  });

  render();
  return {
    update({ biome, dimension, mode } = {}) {
      if (mode !== undefined && creative !== (mode === "creative")) {
        creative = mode === "creative";
        updateTravelControls();
      }
      if (biome !== undefined) currentBiome = biome;
      if (dimension !== undefined) currentDimension = dimension;
      else if (biome?.dimension) currentDimension = biome.dimension;
      if (!container.hidden) updateCurrent();
    },
    refresh: updateCurrent,
    dispose() {
      disposed = true;
    },
  };
}
