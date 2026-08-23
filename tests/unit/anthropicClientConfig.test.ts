import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AdvisorContext } from "@/lib/ai/advisor/schema";

/**
 * Provider-boundary tests (Phase 8). Mocks only -- no network access, no
 * real Anthropic call. These close a real gap found during the offline
 * Phase 8 readiness audit: docs/architecture/ai-advisor.md claims a test
 * asserts only anthropicAdvisor.ts imports @anthropic-ai/sdk, but no such
 * test existed, and nothing verified the timeout/maxRetries values chosen
 * in lib/ai/anthropicModel.ts and lib/ai/advisor/anthropicAdvisor.ts were
 * actually passed to the SDK client rather than just written in a comment.
 *
 * The mock's `messages.create` is never meant to resolve successfully --
 * both provider `run()` methods build their request object (which throws
 * or the mock rejects) only *after* `getClient()` has already constructed
 * the client, so the constructor call is captured regardless of what
 * happens afterward. Each test therefore ignores the run() rejection and
 * asserts only on the captured constructor arguments.
 */

describe("Anthropic client configuration (Phase 8)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-secret";
  });

  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("AnthropicAssessmentModel constructs its SDK client with timeout=120000 and maxRetries=2", async () => {
    const constructorArgs: unknown[] = [];
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = { create: vi.fn().mockRejectedValue(new Error("no network in this test")) };
        constructor(config: unknown) {
          constructorArgs.push(config);
        }
      },
    }));

    const { AnthropicAssessmentModel } = await import("@/lib/ai/anthropicModel");
    const model = new AnthropicAssessmentModel("claude-sonnet-5");
    await model
      .run({
        systemPrompt: "system",
        jobContext: { title: "Test job", problemDescription: null },
        images: [],
      })
      .catch(() => {
        // Expected: the mock never returns a real response. Only the
        // constructor call, captured above, is under test.
      });

    expect(constructorArgs).toHaveLength(1);
    expect(constructorArgs[0]).toMatchObject({ timeout: 120_000, maxRetries: 2 });
  });

  it("AnthropicDiagnosticAdvisor constructs its SDK client with timeout=45000 and maxRetries=2", async () => {
    const constructorArgs: unknown[] = [];
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = { create: vi.fn().mockRejectedValue(new Error("no network in this test")) };
        constructor(config: unknown) {
          constructorArgs.push(config);
        }
      },
    }));

    const { AnthropicDiagnosticAdvisor } = await import("@/lib/ai/advisor/anthropicAdvisor");
    const advisor = new AnthropicDiagnosticAdvisor("claude-sonnet-5");
    await advisor
      .run({
        systemPrompt: "system",
        context: {} as unknown as AdvisorContext,
        question: null,
      })
      .catch(() => {
        // Expected -- see comment above.
      });

    expect(constructorArgs).toHaveLength(1);
    expect(constructorArgs[0]).toMatchObject({ timeout: 45_000, maxRetries: 2 });
  });
});

describe("Anthropic SDK import boundary (Phase 8)", () => {
  it("only the two provider implementation files import @anthropic-ai/sdk", () => {
    const libRoot = path.resolve(__dirname, "..", "..", "lib");
    const allowed = new Set(
      [
        path.join("ai", "anthropicModel.ts"),
        path.join("ai", "advisor", "anthropicAdvisor.ts"),
      ].map((p) => path.resolve(libRoot, p)),
    );
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        // The generated Prisma client is not application source and is
        // gitignored; nothing here needs to walk into it.
        if (entry === "generated") continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith(".ts") || allowed.has(full)) continue;
        if (readFileSync(full, "utf8").includes("@anthropic-ai/sdk")) {
          offenders.push(path.relative(libRoot, full));
        }
      }
    }
    walk(libRoot);

    expect(offenders).toEqual([]);
  });
});
