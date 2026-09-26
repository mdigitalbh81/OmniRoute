/**
 * CodeBuddyCN User-Agent constant (client-safe).
 * Single source of truth for the CLI/CodeBuddy version string across
 * provider registry, OAuth configuration, and usage/quota fetchers.
 *
 * Mismatched version string across a single account's auth vs. chat calls
 * is flagged by Tencent's WAF as anomalous (#12702).
 */
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.108.1 CodeBuddy/2.108.1";
