import { focusFirst, setText } from "./dom.js";

const PAGE_TITLES = {
  options: "Options",
  controls: "Controls",
  video: "Video Settings",
  world: "World Settings",
  "new-world": "Create New World",
};

export function createMenuNavigation(
  menu,
  { listen, onNavigate = () => {}, canNavigate = () => true }
) {
  const $ = (selector) => menu.querySelector(selector);
  let mode = "title";
  let page = "main";
  let history = [];

  function render(focus = true) {
    menu.dataset.page = page;
    menu.classList.toggle("is-paused", mode === "pause");
    menu.setAttribute(
      "aria-label",
      page === "main"
        ? mode === "pause"
          ? "Game menu"
          : "Main menu"
        : PAGE_TITLES[page]
    );
    $(".settings-panel").hidden = page === "main";
    menu.querySelectorAll("[data-menu-page]").forEach((node) => {
      node.hidden = node.dataset.menuPage !== page;
    });
    $(".title-copy").hidden = mode !== "title" || page !== "main";
    $(".menu-title").hidden = mode === "title" && page === "main";
    setText(
      $(".menu-title"),
      page === "main" ? "Game Menu" : PAGE_TITLES[page]
    );
    $(".settings-toggle").setAttribute(
      "aria-expanded",
      String(page !== "main")
    );
    $(".single-world-note").hidden = mode === "pause";
    $(".title-footer").hidden = mode !== "title" || page !== "main";
    if (focus && !menu.hidden) focusFirst(menu);
    onNavigate(page);
  }

  function navigate(next) {
    if (!canNavigate()) return false;
    if (next !== "main" && !Object.hasOwn(PAGE_TITLES, next)) return false;
    if (next === page) return false;
    history.push(page);
    page = next;
    render();
    return true;
  }

  function back() {
    if (!canNavigate()) return false;
    if (page === "main") return false;
    page = history.pop() || "main";
    render();
    return true;
  }

  listen(menu, "click", (event) => {
    const target = event.target.closest("[data-menu-target]");
    if (target && !target.disabled) navigate(target.dataset.menuTarget);
  });
  listen($(".menu-back-button"), "click", back);

  return {
    navigate,
    back,
    get page() {
      return page;
    },
    show(nextMode, { focus = true } = {}) {
      mode = nextMode === "pause" ? "pause" : "title";
      page = "main";
      history = [];
      render(focus);
    },
  };
}
