# Security Policy

## Scope

This repository owns the container/distribution wrapper around `@softeria/ms-365-mcp-server`. It does not modify the upstream server source.

Report issues here when they concern this repository's Dockerfile, dependency lock, build/release workflow, published container image or documentation.

For vulnerabilities in the MS365 MCP application itself, report them to the upstream Softeria project through its published security/support channels.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/X1pheR/ms365-mcp/security/advisories/new) for a suspected vulnerability in this distribution boundary. Do not include access tokens, client secrets, cookies, account-state files, private keys or other sensitive values in a public issue.

For a non-sensitive wrapper or distribution defect, a normal GitHub issue is appropriate. If private vulnerability reporting is unexpectedly unavailable, provide only a minimal non-sensitive public notice and wait for a private reporting route before sharing sensitive reproduction material.

## Supported versions

Only the current published distribution release is maintained. Security fixes are developed on `main` and released through the normal distribution lifecycle. A newer upstream npm release is not automatically supported until this repository has updated, validated and released a matching distribution baseline.

## Dependency and build security

The repository uses an exact upstream package version, committed npm lockfile, digest-pinned runtime base image, full-SHA-pinned GitHub Actions, production dependency audit, container contract validation, Dependabot and OpenSSF Scorecard. Public-release acceptance additionally reviews applicable GitHub-native dependency alerts, secret scanning with push protection, CodeQL results, release immutability and build provenance.

These controls supplement rather than replace upstream vulnerability handling and runtime acceptance of the packaged MS365 MCP behavior.
