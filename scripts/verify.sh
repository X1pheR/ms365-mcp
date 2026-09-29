#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null
command -v docker >/dev/null
revision="${VERIFY_REVISION:-$(git rev-parse HEAD)}"
readarray -t versions < <(python3 - <<'PY'
import json
p=json.load(open('package.json', encoding='utf-8'))
print(p['version'])
print(p['dependencies']['@softeria/ms-365-mcp-server'])
PY
)
distribution_version="${versions[0]}"
upstream_version="${versions[1]}"
case "$distribution_version" in
  "$upstream_version"-x1pher.*) ;;
  *) echo "distribution version must extend exact upstream version" >&2; exit 1 ;;
esac
docker build --build-arg VERSION="$distribution_version" --build-arg REVISION="$revision" -t ms365-mcp:verify .
docker run --rm --entrypoint npm ms365-mcp:verify audit --omit=dev --package-lock-only --audit-level=moderate
test "$(docker run --rm --entrypoint node ms365-mcp:verify -p "require('/app/node_modules/@softeria/ms-365-mcp-server/package.json').version")" = "$upstream_version"
docker run --rm ms365-mcp:verify --help >/dev/null
docker run --rm --entrypoint node ms365-mcp:verify --check /app/src/entrypoint.mjs
docker run --rm --entrypoint node ms365-mcp:verify --check /app/src/mail-attachment-tools.mjs
docker run --rm -v "$PWD/test:/app/test:ro" --entrypoint node ms365-mcp:verify --test /app/test/mail-attachment-tools.test.mjs
test "$(docker image inspect ms365-mcp:verify --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" = "https://github.com/X1pheR/ms365-mcp"
test "$(docker image inspect ms365-mcp:verify --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision"
git diff --check
