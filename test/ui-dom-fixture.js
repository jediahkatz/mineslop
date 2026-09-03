// Lightweight node behavior for isolated HUD/slot tests, not visual evidence.
// Delegated events can be supplied by controller tests; real browser capture,
// layout and focus routing remain in the opt-in UI integration suite.
export function uiDomFixture(t) {
  const previousDocument = globalThis.document;
  const document = {
    activeElement: null,
    defaultView: Object.assign(new EventTarget(), {
      innerWidth: 1280,
      innerHeight: 720,
    }),
  };
  class Node extends EventTarget {
    constructor(tag = "div") {
      super();
      this.tagName = tag.toUpperCase();
      this.ownerDocument = document;
      this.dataset = {};
      this.children = [];
      this.textContent = "";
      this.className = "";
      this.hidden = false;
      this.offsetWidth = 180;
      this.offsetHeight = 40;
      this.attributes = new Map();
      this.properties = new Map();
      this.style = {
        setProperty: (key, value) => this.properties.set(key, String(value)),
        getPropertyValue: (key) => this.properties.get(key) || "",
      };
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        toggle: (name, enabled = !this.classList.contains(name)) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          if (enabled) names.add(name);
          else names.delete(name);
          this.className = [...names].join(" ");
          return enabled;
        },
        add: (name) => this.classList.toggle(name, true),
        remove: (name) => this.classList.toggle(name, false),
      };
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
    contains(node) {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    matches(selector) {
      if (selector.startsWith("."))
        return this.classList.contains(selector.slice(1));
      if (selector === "[hidden]") return this.hidden;
      const attributes = [
        ...selector.matchAll(/\[data-([a-z-]+)(?:="([^"]*)")?\]/g),
      ];
      if (
        !attributes.length ||
        attributes.map(([match]) => match).join("") !== selector
      )
        return false;
      return attributes.every(([, name, value]) => {
        const key = name.replace(/-([a-z])/g, (_, letter) =>
          letter.toUpperCase()
        );
        return value === undefined
          ? key in this.dataset
          : this.dataset[key] === value;
      });
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((node) => [
        ...(node.matches(selector) ? [node] : []),
        ...node.querySelectorAll(selector),
      ]);
    }
    closest(selector) {
      if (this.matches(selector)) return this;
      return this.parentElement?.closest(selector) || null;
    }
    focus() {
      document.activeElement = this;
    }
    getBoundingClientRect() {
      return { top: 100, right: 200 };
    }
    getContext() {
      return {
        drawImage() {},
        putImageData() {},
        save() {},
        restore() {},
        setTransform() {},
        fillRect() {},
        createImageData: (width, height) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
      };
    }
    toDataURL() {
      return "data:image/png;base64,unit-test-icon";
    }
    remove() {
      if (this.parentElement)
        this.parentElement.children = this.parentElement.children.filter(
          (node) => node !== this
        );
    }
  }
  document.createElement = (tag) => new Node(tag);
  globalThis.document = document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) {
      const node = new Node();
      if (selector.startsWith("[data-vital=")) new Node().append(node);
      nodes.set(selector, node);
    }
    return nodes.get(selector);
  };
  return {
    document,
    Node,
    get,
    root: { ownerDocument: document, querySelector: get },
  };
}
