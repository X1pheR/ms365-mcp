# Changelog

## 0.143.0-x1pher.3 - 2026-09-02

- Fix the live MCP input schema for `save-mail-attachment`; all required and optional parameters are now visible through `tools/list` instead of an empty object schema.
- Keep durable/temporary cross-field validation in the runtime handler so the wire schema remains a plain machine-readable Zod object without weakening validation.
- Add a regression test that rejects future schema-wrapper regressions before release.

## 0.143.0-x1pher.2 - 2026-09-02

- Add a narrow downstream Outlook mail-attachment persistence extension without modifying the pinned Softeria source package.
- Add `save-mail-attachment`, `promote-mail-attachment`, and `cleanup-mail-attachment` with server-side Graph `/$value` streaming, SHA-256 provenance, size/path/no-clobber guards, temporary TTL cleanup, and optional bounded durable storage.
- Keep attachment bytes and base64 out of MCP/model responses.

This file records user-visible changes to the maintained MS365 MCP container distribution. Upstream application changes remain documented by the Softeria project.

## Unreleased

- Added public OpenSSF Scorecard reporting and protected-branch repository controls.
- Future image releases publish signed GitHub/Sigstore build provenance for the exact GHCR manifest digest.
- Added explicit contribution and private vulnerability-reporting routes.
- Hardened release recovery around an existing exact tag and source commit.

## 0.143.0-x1pher.1 - 2026-08-16

- Updated the maintained upstream package baseline to `@softeria/ms-365-mcp-server` `0.143.0`.
- Published the independently versioned container distribution through GHCR and GitHub Releases.
- Retained the separate deployment/runtime configuration boundary outside this repository.
