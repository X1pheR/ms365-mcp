# MS365 MCP Container

Community-maintained container distribution for the upstream [`@softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) project.

This repository is **not a source fork**. It does not copy or modify the upstream MS365 MCP server source. It owns a separate distribution boundary: the tested upstream package version, dependency lock, pinned Node base image, container build, security checks and published GHCR image. Upstream application behavior, tools and Microsoft Graph integration remain owned by Softeria.

This project is maintained independently by X1pheR and is not affiliated with, endorsed by or officially maintained by Softeria or Microsoft.

## Why this repository exists

Running an upstream npm package directly is convenient, but a maintained deployment benefits from an immutable container artifact that can be reviewed and promoted separately from runtime configuration.

The repository therefore provides:

- an exact upstream package baseline;
- a reviewed `package-lock.json`;
- a digest-pinned Node base image;
- a reproducible Docker build definition;
- CI and dependency/security checks;
- versioned GHCR publication for immutable deployment by manifest digest.

The repository deliberately does **not** own Hypershell-specific tool filters, Graph scopes, ports, token state or deployment configuration. Those belong to the consuming deployment.

## Current compatibility baseline

| Component | Tested baseline |
|---|---|
| Upstream package | `@softeria/ms-365-mcp-server` `0.143.0` |
| Distribution release | `0.143.0-x1pher.1` |
| Runtime | Node 22 Bookworm, pinned by image digest in `Dockerfile` |

A newer upstream package does not become supported merely because it exists. Updating the upstream baseline is compatibility work: update the exact dependency and lock, run CI/security checks, test representative MCP behavior, then publish a new distribution release.

## Image

Published releases use:

```text
ghcr.io/x1pher/ms365-mcp:<distribution-version>
```

For standing deployments, prefer the immutable manifest digest returned by the accepted release rather than a mutable tag:

```yaml
services:
  ms365:
    image: ghcr.io/x1pher/ms365-mcp@sha256:<accepted-manifest-digest>
```

To inspect the packaged upstream CLI:

```bash
docker run --rm ghcr.io/x1pher/ms365-mcp:0.143.0-x1pher.1 --help
```

## Runtime state

The image contains the application and its dependencies under `/app`. Persistent account and token state should be mounted separately at `/data` when file-backed authentication state is used.

Starting with the tested upstream `0.143.0` baseline, the upstream server encrypts the file-backed token cache. In the tested headless container fallback it creates `/data/.cache-key` with mode `0600` alongside the encrypted token cache. Persist and protect the complete `/data` state boundary; `token-cache.json` without its matching `.cache-key` is not a complete recovery set. When upgrading from an older plaintext-cache release, keep a protected pre-upgrade copy until the new release has passed runtime acceptance because older releases cannot use the migrated encrypted cache.

Example:

```bash
docker run --rm \
  -p 3010:3010 \
  -e HOME=/data \
  -e MS365_MCP_TOKEN_CACHE_PATH=/data/token-cache.json \
  -e MS365_MCP_SELECTED_ACCOUNT_PATH=/data/selected-account.json \
  -v ms365-data:/data \
  ghcr.io/x1pher/ms365-mcp:0.143.0-x1pher.1 \
  --http 0.0.0.0:3010
```

The upstream server owns authentication behavior and Microsoft Graph calls. This image does not add an authorization layer. Configure enabled tools and allowed Graph scopes through the upstream server's supported runtime options according to the deployment's needs.

## Tool surface

This repository does not define, patch or filter MCP tools. The tool surface comes entirely from the pinned upstream package and can also be narrowed at runtime with upstream options. Refer to the [upstream project](https://github.com/Softeria/ms-365-mcp-server) for the tool and CLI reference for the pinned package baseline.

If this project ever needs to modify upstream source or carry a source-level behavioral delta, that is a different maintenance boundary: create or adopt an explicit source fork, document the delta and track upstream separately. Do not silently turn this distribution repository into a hidden fork.

## Build locally

```bash
docker build \
  --build-arg VERSION=0.143.0-x1pher.1 \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  -t ms365-mcp:local \
  .
```

Then verify the packaged upstream version:

```bash
docker run --rm --entrypoint node ms365-mcp:local \
  -p "require('/app/node_modules/@softeria/ms-365-mcp-server/package.json').version"
```

## Release model

The distribution version intentionally distinguishes this maintained container release from the upstream npm version. For example:

```text
upstream:     0.143.0
distribution: 0.143.0-x1pher.1
Git tag:      v0.143.0-x1pher.1
image tag:    0.143.0-x1pher.1
```

A release tag is accepted only from the current `main` revision. Release automation re-runs the production dependency audit, builds the container and publishes the versioned GHCR image. Consumers should promote the resulting manifest digest.

## Security

Do not place Microsoft tokens, client secrets, tenant-specific credentials or account-state files in this repository or image. See [`SECURITY.md`](SECURITY.md) for reporting guidance and the upstream project for vulnerabilities in the MS365 MCP application itself.

## License and upstream attribution

The wrapper files in this repository are licensed under the MIT License; see [`LICENSE`](LICENSE).

The packaged `@softeria/ms-365-mcp-server` software is an independent upstream project and is also distributed under its own MIT license. Its source, copyright and license remain governed by that project. Transitive dependencies retain their respective licenses.
