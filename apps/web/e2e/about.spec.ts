import { expect, test } from "@playwright/test";
import { A, boot, type Harness } from "./harness.js";

let h: Harness;
test.beforeEach(async () => { h = await boot(4198, "about-page", { [A]: { provider: "fake" } }); });
test.afterEach(async () => { await h.close(); });

test("About supports keyboard navigation, history and direct reload without starting work", async ({ context }) => {
  const page = await h.openApp(context);
  const about = page.getByRole("navigation", { name: "System", exact: true }).getByRole("link", { name: "About", exact: true });
  await about.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${h.origin}/#/about`);
  await expect(page).toHaveTitle("About · Agentic OS");
  await expect(about).toHaveAttribute("aria-current", "page");
  const main = page.getByRole("main");
  await expect(main).toBeFocused();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("About Agentic OS");
  await expect(main.getByRole("table")).toHaveAccessibleName("Linux concepts and their Agentic OS counterparts");
  await expect(main.getByRole("list").getByRole("heading", { level: 3 })).toHaveText(["Prompt", "Routing", "Execution", "Verification", "Result"]);
  await page.reload();
  await expect(main.getByRole("heading", { name: "About Agentic OS", exact: true })).toBeVisible();
  await main.getByRole("navigation", { name: "Explore Agentic OS" }).getByRole("link", { name: "Inspect agents", exact: true }).click();
  await expect(page).toHaveURL(`${h.origin}/#/agents`);
  await page.goBack();
  await expect(about).toHaveAttribute("aria-current", "page");
  await expect(main).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(`${h.origin}/#/agents`);
  expect(h.built.tasks.list()).toHaveLength(0);
});

test("About keeps capability limits readable across desktop and mobile", async ({ context }, info) => {
  const errors: string[] = [];
  context.on("page", page => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  });
  const page = await h.openApp(context);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${h.origin}/#/about`);
  const article = page.getByRole("article", { name: "About Agentic OS" });
  for (const [name, status] of [
    ["Automatic model selection", "Shadow by default · activation gated"],
    ["Automatic subtasks", "Planned"],
    ["Agent plugins", "Partly implemented · broader support planned"],
    ["Codex fallback", "Implemented · conditional"],
  ]) {
    await expect(article.getByRole("region", { name, exact: true })).toContainText(status!);
  }
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(article.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const nav = page.getByRole("navigation", { name: "System", exact: true });
    // About sits in the system group: always shown on desktop, one More away on narrow screens.
    if (width <= 760) {
      await expect(nav.getByRole("button", { name: "More", exact: true })).toHaveClass(/is-current/);
      const more = nav.getByRole("button", { name: "More", exact: true });
      if (await more.getAttribute("aria-expanded") === "false") await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
    }
    await expect(nav.getByRole("link", { name: "About", exact: true })).toBeInViewport();
    await expect(nav.getByRole("link", { name: "About", exact: true })).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: info.outputPath(`about-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
