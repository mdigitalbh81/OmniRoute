import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getAntigravityQuotaFamily,
  getQuotaScopedModelForProvider,
} from "@omniroute/open-sse/services/antigravityQuotaFamily.ts";
import {
  clearAllModelLockouts,
  getModelLockoutInfo,
  isModelLocked,
  recordModelLockoutFailure,
} from "@omniroute/open-sse/services/accountFallback.ts";

const provider = "antigravity";

describe("Antigravity account exact-model scoped lockout", () => {
  beforeEach(() => {
    clearAllModelLockouts();
    vi.useRealTimers();
  });

  it("checks classification of models to families (still defined but models are exact-model scoped)", () => {
    expect(getAntigravityQuotaFamily("gemini-3.5-flash-medium")).toBe("gemini");
    expect(getAntigravityQuotaFamily("google/gemini-3.5-flash-low")).toBe("gemini");
    expect(getAntigravityQuotaFamily("claude-sonnet-4")).toBe("claude");
    expect(getAntigravityQuotaFamily("cloud/claude-opus-4")).toBe("claude");
  });

  it("returns exact model for getQuotaScopedModelForProvider in Antigravity", () => {
    expect(getQuotaScopedModelForProvider(provider, "claude-opus-4-6-thinking")).toBe(
      "claude-opus-4-6-thinking"
    );
    expect(getQuotaScopedModelForProvider(provider, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(getQuotaScopedModelForProvider(provider, "gemini-3.5-flash-high")).toBe(
      "gemini-3.5-flash-high"
    );
  });

  it("locks only the exact model experiencing 429", () => {
    recordModelLockoutFailure(
      provider,
      "account-a",
      "claude-opus-4-6-thinking",
      "rate_limited",
      429,
      60_000,
      null,
      { maxCooldownMs: 300_000 }
    );

    expect(isModelLocked(provider, "account-a", "claude-opus-4-6-thinking")).toBe(true);
    expect(isModelLocked(provider, "account-a", "claude-sonnet-4-6")).toBe(false);
    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-high")).toBe(false);
  });

  it("locks Gemini Flash 429 model only", () => {
    recordModelLockoutFailure(
      provider,
      "account-a",
      "gemini-3.5-flash-high",
      "rate_limited",
      429,
      60_000,
      null,
      { maxCooldownMs: 300_000 }
    );

    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-high")).toBe(true);
    expect(isModelLocked(provider, "account-a", "gemini-3.5-flash-low")).toBe(false);
  });

  it("honors exact upstream cooldowns on exact-model lockouts", () => {
    const upstream = recordModelLockoutFailure(
      provider,
      "account-a",
      "claude-opus-4-6-thinking",
      "rate_limited",
      429,
      1_000,
      null,
      { exactCooldownMs: 123_000, maxCooldownMs: 300_000 }
    );
    expect(upstream.cooldownMs).toBe(123_000);
    expect(
      getModelLockoutInfo(provider, "account-a", "claude-opus-4-6-thinking")?.remainingMs
    ).toBeGreaterThan(100_000);
  });
});
