import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEBUDDY_CN_USER_AGENT } from "../../src/shared/constants/codebuddyCn.ts";
import {
  CODEBUDDY_CN_USER_AGENT as OAUTH_CODEBUDDY_CN_USER_AGENT,
  CODEBUDDY_CN_CONFIG,
} from "../../src/lib/oauth/constants/oauth.ts";
import codebuddy_cnProvider from "../../open-sse/config/providers/registry/codebuddy-cn/index.ts";

describe("codebuddy-cn client-safe constant", () => {
  it("maintains exact previous constant value", () => {
    assert.equal(CODEBUDDY_CN_USER_AGENT, "CLI/2.108.1 CodeBuddy/2.108.1");
  });

  it("oauth.ts continues exposing and using the same expected value", () => {
    assert.equal(OAUTH_CODEBUDDY_CN_USER_AGENT, CODEBUDDY_CN_USER_AGENT);
    assert.equal(CODEBUDDY_CN_CONFIG.userAgent, CODEBUDDY_CN_USER_AGENT);
  });

  it("codebuddy-cn provider registry uses the same shared value", () => {
    assert.equal(codebuddy_cnProvider.headers?.["User-Agent"], CODEBUDDY_CN_USER_AGENT);
  });

  it("the new shared module has no node-only or server-only imports", () => {
    const filePath = join(process.cwd(), "src/shared/constants/codebuddyCn.ts");
    const content = readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, /import\s+.*from\s+['"]node:/);
    assert.doesNotMatch(content, /import\s+.*from\s+['"](fs|os|path|child_process)['"]/);
    assert.doesNotMatch(content, /import\s+.*from\s+['"].*oauth.*['"]/);
    assert.doesNotMatch(content, /import\s+.*from\s+['"].*cursorAgentCliVersion.*['"]/);
  });
});
