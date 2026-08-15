import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  // Dev-mode Turbopack compiles routes on first hit, not ahead of time --
  // a cold dev server's first navigation (plus a real Supabase Auth
  // round trip) can comfortably exceed the 5s default.
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
