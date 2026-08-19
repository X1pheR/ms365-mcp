# Changelog

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
