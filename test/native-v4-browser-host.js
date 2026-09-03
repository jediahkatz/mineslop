export const NATIVE_V4_PROTECTED_PORTS = Object.freeze([
  "5173",
  "5280",
  "5290",
  "5297",
  "5311",
  "5352",
  "5363",
  "5487",
  "5488",
  "5491",
  "5503",
  "5504",
  "5505",
]);

/** No default host, DNS aliases, credentials, shorthand IPs or shared ports. */
export function readNativeV4Host(value) {
  if (typeof value !== "string" || !value.length || value !== value.trim())
    throw new Error(
      "Set VOXELCRAFT_TEST_URL to a new isolated frozen numeric-loopback origin"
    );
  // Require the numeric literal in the input, before URL canonicalizes aliases.
  if (
    !/^https?:\/\/(?:127(?:\.(?:0|[1-9]\d{0,2})){3}|\[::1\]):[1-9]\d{0,4}\/?$/.test(
      value
    )
  )
    throw new Error(
      "Native v4 requires a numeric-loopback root URL with an explicit fresh port"
    );
  const base = new URL(value);
  if (!base.port || NATIVE_V4_PROTECTED_PORTS.includes(base.port))
    throw new Error(
      "Native v4 cannot use a protected/shared origin or a default port"
    );
  return base;
}

/** Compile-time Vite flags, never a URL parameter or a runtime label injection. */
export function assertNativeV4FrozenBuild(build, expectedLabel) {
  if (
    build?.fixture !== "native-v4-worker" ||
    build.production !== true ||
    build.development !== false ||
    build.hmr !== false ||
    !(build.label === null || typeof build.label === "string")
  )
    throw new Error(
      "Native v4 acceptance requires the frozen production fixture, never HMR"
    );
  if (expectedLabel !== undefined && build.label !== expectedLabel)
    throw new Error(
      `Unexpected compiled native-v4 build label: ${JSON.stringify(build.label)}`
    );
}

/** Inspect the fetched document BEFORE any page code runs. No source rewriting. */
export function nativeV4BuiltScripts(html, base) {
  if (
    typeof html !== "string" ||
    html.length > 65536 ||
    !/<meta\s+name=["']voxelcraft-test-fixture["']\s+content=["']native-v4-worker["']\s*\/?>/i.test(
      html
    ) ||
    /\/@vite\/|\/@react-refresh|<base\b/i.test(html)
  )
    throw new Error(
      "Expected the bounded frozen native-v4 fixture HTML, not a development or game page"
    );
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (!tags.length)
    throw new Error("Frozen native-v4 fixture has no compiled module entry");
  return tags.map(([, attributes, body]) => {
    const source = /(?:^|\s)src\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (
      !source ||
      !/(?:^|\s)type\s*=\s*["']module["']/i.test(attributes) ||
      body.trim()
    )
      throw new Error(
        "Frozen native-v4 fixture requires external compiled modules only"
      );
    const script = new URL(source, base);
    if (
      script.origin !== base.origin ||
      script.username ||
      script.password ||
      !/^\/assets\/[^/]+\.js$/.test(script.pathname) ||
      script.search ||
      script.hash
    )
      throw new Error(
        "Frozen native-v4 modules must be same-origin build assets, not source/HMR"
      );
    return script.href;
  });
}
