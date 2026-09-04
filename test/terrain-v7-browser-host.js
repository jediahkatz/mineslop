import { readNativeV4Host } from "./native-v4-browser-host.js";

// Reuse the frozen test-origin policy, not an application/default URL.
export const readV7BrowserHost = readNativeV4Host;
export const V7_BROWSER_SOURCE = "6ea12b135d8e30d8434b4f5156ab5bd08c417478";

export function assertV7BrowserBuild(build, source = V7_BROWSER_SOURCE, label) {
  if (build?.fixture !== "terrain-v7-worker" || build.production !== true ||
      build.development !== false || build.hmr !== false ||
      !/^[a-f0-9]{40}$/.test(source) || build.source !== source ||
      typeof build.label !== "string" || !build.label ||
      (label !== undefined && build.label !== label))
    throw new Error("Expected the exact frozen v7 production source and build label");
}

export function v7BuiltScripts(html, base) {
  if (typeof html !== "string" || html.length > 65536 ||
      !/<meta\s+name=["']voxelcraft-test-fixture["']\s+content=["']terrain-v7-worker["']\s*\/?>/i.test(html) ||
      /\/@vite\/|\/@react-refresh|<base\b/i.test(html))
    throw new Error("Expected frozen v7 fixture HTML, not a game or HMR page");
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (!tags.length) throw new Error("Missing compiled v7 entry");
  return tags.map(([, attributes, body]) => {
    const src = /(?:^|\s)src\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (!src || body.trim() || !/(?:^|\s)type\s*=\s*["']module["']/i.test(attributes))
      throw new Error("Only external compiled modules are allowed");
    const url = new URL(src, base);
    if (url.origin !== base.origin || url.username || url.password ||
        !/^\/assets\/[^/]+\.js$/.test(url.pathname) || url.search || url.hash)
      throw new Error("Only same-origin frozen build assets are allowed");
    return url.href;
  });
}
