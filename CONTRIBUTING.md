# Contributing

This repository maintains the container/distribution boundary for the upstream `@softeria/ms-365-mcp-server` package. It does not carry upstream application source.

## Before proposing a change

- Keep source-level MS365 MCP behavior changes in the upstream Softeria project unless this repository explicitly adopts a maintained fork boundary.
- Keep Hypershell-specific runtime configuration, tool filtering, Graph scopes, tokens and deployment settings out of this product repository.
- Treat upstream package changes as compatibility work: update the exact package baseline and lockfile together and validate the resulting container.
- Do not include Microsoft tokens, client secrets, cookies, account-state files or private infrastructure values in issues, pull requests, tests or examples.

## Validation

For distribution changes, run or reproduce the checks in `.github/workflows/ci.yml`:

1. verify the distribution and upstream package versions;
2. run the production dependency audit;
3. build the container from the pinned base image;
4. verify the packaged upstream version, CLI startup and OCI source/revision labels.

Release and workflow changes should keep external GitHub Actions pinned to full commit SHAs.

## Pull requests

Keep pull requests focused on one distribution concern. Explain whether the change affects the upstream package baseline, container build, release lifecycle, security boundary or documentation. A green CI run is required but does not replace compatibility or security review.

Security-sensitive reports must follow `SECURITY.md` rather than a public issue or pull request.
