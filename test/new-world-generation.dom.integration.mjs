// Isolated headless DOM/event proof only: no GameRenderer, WebGL, shared profile,
// inventory injection, or use of the desktop occupied by visual acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { chromeExecutable } from "./realtime/config.mjs";

test("real New World form routes the numeric opt-in, keyboard submission and busy guards", { timeout: 60000 }, async (t) => {
  const server = await createServer({
    configFile: false, root: process.cwd(), base: "/",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "isolated-new-world-dom",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/__new-world-dom") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(`<div id="ui"></div><script type="module">
            import { createUI } from "/src/ui.js";
            window.calls = [];
            window.ui = createUI({
              onNewWorld: (seed, version) => {
                calls.push([seed, version]);
                return new Promise(resolve => window.finish = resolve);
              },
              onSave: () => new Promise(resolve => window.finishSave = resolve),
              onPlay: () => {},
            });
            ui.ready(); ui.showMenu("title"); ui.openMenuPage("world");
          </script>`);
        });
      },
    }],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({
    executablePath: await chromeExecutable(process.env.CHROME_BIN),
    headless: true, args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__new-world-dom`);
  await page.waitForFunction(() => !!window.ui);
  await page.locator(".new-world-button").click();
  const choice = page.getByLabel("World Generation", { exact: true });
  assert.equal(await choice.inputValue(), "3");
  assert.equal(await choice.getAttribute("aria-describedby"), "world-generation-help");
  const help = await page.locator("#world-generation-help").textContent();
  assert.match(help, /deeper Overworld/);
  assert.match(help, /Visual acceptance is unfinished/);
  assert.match(await page.locator(".world-replace-warning").textContent(), /Export/);
  await page.locator("#world-seed").fill("  chosen-seed  ");
  await page.keyboard.press("Tab");
  assert.equal(await choice.evaluate((element) => element === document.activeElement), true);
  // Real Game HUD refreshes continue while the New World form has focus.
  // Focusing the generation selector must not overwrite the seed draft.
  await page.evaluate(() => ui.update({ seed: "cedar-valley" }));
  assert.equal(await page.locator("#world-seed").inputValue(), "  chosen-seed  ");
  await page.keyboard.press("End");
  assert.equal(await choice.inputValue(), "7");
  await page.evaluate(() => ui.update({ seed: "cedar-valley" }));
  assert.equal(await page.locator("#world-seed").inputValue(), "  chosen-seed  ");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".generate-button").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => calls.length === 1);
  assert.deepEqual(await page.evaluate(() => calls), [["chosen-seed", 7]]);
  assert.equal(await choice.isDisabled(), true);
  assert.equal(await page.locator("#world-seed").isDisabled(), true);
  assert.equal(await page.locator(".generate-button").isDisabled(), true);
  assert.equal(await page.locator(".menu-back-button").isDisabled(), true);
  await page.evaluate(() => document.querySelector(".seed-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(await page.evaluate(() => calls.length), 1);
  await page.evaluate(() => finish(false));
  await page.waitForFunction(() => !document.querySelector("#world-generation").disabled);
  assert.match(await page.locator(".storage-status").textContent(), /unchanged/);
  assert.equal(await choice.inputValue(), "7");
  await page.evaluate(() => ui.update({ seed: "cedar-valley" }));
  assert.equal(await page.locator("#world-seed").inputValue(), "chosen-seed");
  // HUD/import version updates must not feed back into the opt-in control.
  await page.evaluate(() => ui.update({ generatorVersion: 1 }));
  assert.equal(await choice.inputValue(), "7");
  await page.evaluate(() => {
    const select = document.querySelector("#world-generation");
    select.add(new Option("tampered", "4"));
    select.value = "4";
    document.querySelector(".seed-form").requestSubmit();
  });
  await page.waitForFunction(() => document.querySelector(".storage-status").textContent.includes("Choose Classic"));
  assert.equal(await page.evaluate(() => calls.length), 1);
  assert.equal(await choice.isDisabled(), false);
  await choice.selectOption("3");
  await page.locator("#world-seed").fill(" ");
  await page.locator(".generate-button").click();
  await page.waitForFunction(() => calls.length === 2);
  assert.deepEqual(await page.evaluate(() => calls[1]), ["cedar-valley", 3]);
  await page.evaluate(() => finish({ ok: false, message: "Storage rejected" }));
  await page.waitForFunction(() => !document.querySelector("#world-generation").disabled);
  assert.match(await page.locator(".storage-status").textContent(), /Storage rejected/);
  await page.evaluate(() => ui.openMenuPage("world"));
  await page.locator(".save-button").click();
  assert.equal(await choice.isDisabled(), true);
  await page.evaluate(() => document.querySelector(".seed-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(await page.evaluate(() => calls.length), 2);
  await page.evaluate(() => finishSave({ ok: true }));
  await page.waitForFunction(() => !document.querySelector("#world-generation").disabled);
  assert.deepEqual(errors, []);
});
