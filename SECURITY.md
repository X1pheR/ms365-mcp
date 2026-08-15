# Security Policy

## Scope

This repository owns the container/distribution wrapper around `@softeria/ms-365-mcp-server`. It does not modify the upstream server source.

Report issues here when they concern this repository's Dockerfile, dependency lock, build/release workflow, published container image or documentation.

For vulnerabilities in the MS365 MCP application itself, report them to the upstream Softeria project through its published security/support channels.

## Reporting

Open a GitHub issue for a wrapper or distribution problem that can be described safely without credentials or exploit secrets. Do not include access tokens, client secrets, cookies, account-state files, private keys or other sensitive values.

If public disclosure would expose a working secret or create immediate risk, provide only a minimal non-sensitive notice and wait for a private reporting route before sharing sensitive reproduction material.

## Supported versions

Only the current published distribution release is maintained. A newer upstream npm release is not automatically supported until this repository has updated, validated and released a matching distribution baseline.
