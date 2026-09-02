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

## Downstream mail-attachment boundary

The attachment extension reuses the pinned upstream MS365 process and token handling but never returns attachment bytes through MCP. It requests attachment metadata with a bounded `$select`, requires a Graph `fileAttachment`, streams `/$value` to an exclusive `0600` temporary file, enforces the configured byte ceiling while streaming, hashes the exact bytes with SHA-256, fsyncs them, and publishes atomically with no-clobber semantics unless overwrite is explicitly requested. Unsafe path components and symlinks are rejected. Temporary artifacts are UUID-scoped and TTL-cleaned; invalid/unknown directories fail closed and are not removed automatically.

A configured durable root is a deliberate host-data trust boundary: compromise of the MS365 container could reach any writable mount independently of MCP-level path validation. Deployments should therefore mount only the smallest durable document tree that satisfies their ownership model and keep the container and upstream dependencies patched. Attachment files are preserved as evidence/data and are never executed by the extension; MIME, extension, and magic-signature mismatches are returned as warnings for downstream analyzers.
