import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNativeV4FrozenBuild,
  nativeV4BuiltScripts,
  NATIVE_V4_PROTECTED_PORTS,
  readNativeV4Host,
} from "./native-v4-browser-host.js";

test("native browser host accepts only explicit fresh numeric-loopback roots", () => {
  for (const value of [
    "http://127.0.0.1:5517/",
    "http://127.0.0.6:5517",
    "https://[::1]:5517/",
  ])
    assert.equal(readNativeV4Host(value).origin, new URL(value).origin);
  for (const value of [
    undefined,
    null,
    "",
    " ",
    " http://127.0.0.1:5517/",
    "http://127.0.0.1:5517/\n",
    "http://loopback.invalid:5517/",
    "http://127.0.0.1.nip.io:5517/",
    "https://example.com:5517/",
    "http://192.168.0.1:5517/",
    "http://127.1:5517/",
    "http://2130706433:5517/",
    "http://0x7f000001:5517/",
    "http://127.0.0.999:5517/",
    "http://[::2]:5517/",
    "ftp://127.0.0.1:5517/",
    "file:///test/native-v4-worker.html",
    "http://user:password@127.0.0.1:5517/",
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "https://127.0.0.1:443/",
    "http://127.0.0.1:0/",
    "http://127.0.0.1:65536/",
    "http://127.0.0.1:5517/test/native-v4-worker.html",
    "http://127.0.0.1:5517/?build=frozen",
    "http://127.0.0.1:5517/#frozen",
  ])
    assert.throws(
      () => readNativeV4Host(value),
      `must reject ${String(value)}`
    );
});

test("every protected port is refused on every allowed loopback spelling", () => {
  assert.deepEqual(NATIVE_V4_PROTECTED_PORTS, [
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
  for (const hostname of ["127.0.0.1", "127.0.0.6", "[::1]"])
    for (const port of NATIVE_V4_PROTECTED_PORTS)
      for (const protocol of ["http", "https"])
        assert.throws(
          () => readNativeV4Host(`${protocol}://${hostname}:${port}/`),
          /protected/
        );
});

test("frozen native build evidence requires compiled production flags and optionally the exact label", () => {
  const build = {
    fixture: "native-v4-worker",
    production: true,
    development: false,
    hmr: false,
    label: "native-v4-frozen-candidate",
  };
  assert.doesNotThrow(() => assertNativeV4FrozenBuild(build));
  assert.doesNotThrow(() => assertNativeV4FrozenBuild(build, build.label));
  assert.doesNotThrow(() =>
    assertNativeV4FrozenBuild({ ...build, label: null })
  );
  assert.throws(
    () => assertNativeV4FrozenBuild(build, "different-candidate"),
    /label/
  );
  assert.throws(
    () => assertNativeV4FrozenBuild({ ...build, label: null }, build.label),
    /label/
  );
  for (const invalid of [
    null,
    {},
    { ...build, fixture: "realtime" },
    { ...build, production: false },
    { ...build, production: "true" },
    { ...build, development: true },
    { ...build, development: undefined },
    { ...build, hmr: true },
    { ...build, hmr: undefined },
    { ...build, label: {} },
  ])
    assert.throws(() => assertNativeV4FrozenBuild(invalid), /frozen/);
});

test("preflight refuses raw source, HMR, redirects by base tag and wrong-page HTML before loading", () => {
  const base = readNativeV4Host("http://127.0.0.1:5517/");
  const meta =
    '<meta name="voxelcraft-test-fixture" content="native-v4-worker">';
  const module =
    '<script type="module" src="/assets/native-v4-worker-a1b2c3d4.js"></script>';
  assert.deepEqual(nativeV4BuiltScripts(`${meta}${module}`, base), [
    "http://127.0.0.1:5517/assets/native-v4-worker-a1b2c3d4.js",
  ]);
  for (const html of [
    "",
    module,
    meta,
    `<base href="http://127.0.0.1:5280/">${meta}${module}`,
    `${meta}<script type="module" src="/@vite/client"></script>`,
    `${meta}<script type="module" src="/@react-refresh"></script>`,
    `${meta}<script type="module" src="./native-v4-browser-fixture.js"></script>`,
    `${meta}<script type="module" src="/src/terrain.js"></script>`,
    `${meta}<script type="module" src="http://127.0.0.1:5280/assets/worker.js"></script>`,
    `${meta}<script type="module" src="https://example.com/assets/worker.js"></script>`,
    `${meta}<script type="module" src="/assets/worker.js?t=123"></script>`,
    `${meta}<script type="module" src="/assets/worker.js#label"></script>`,
    `${meta}<script src="/assets/worker.js"></script>`,
    `${meta}<script data-type="module" src="/assets/worker.js"></script>`,
    `${meta}<script type="module" data-src="/assets/worker.js" src="/src/terrain.js"></script>`,
    `${meta}<script type="module">import "/src/terrain.js";</script>`,
    `${meta}${module}${" ".repeat(65536)}`,
  ])
    assert.throws(() => nativeV4BuiltScripts(html, base));
});
