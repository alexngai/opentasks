#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <host> <ssh-key-path> [remote-dir]" >&2
  exit 2
fi

host="$1"
ssh_key="$2"
remote_dir="${3:-/home/ubuntu/opentasks}"

ssh_base=(ssh -n -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$ssh_key" "ubuntu@$host")
rsync_ssh="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $ssh_key"

npm run build

runtime_pkg="$(mktemp)"
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); delete p.devDependencies; delete p.scripts; fs.writeFileSync(process.argv[1], JSON.stringify(p,null,2)+"\n");' "$runtime_pkg"

"${ssh_base[@]}" "set -euo pipefail
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg rsync build-essential
  if ! node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  mkdir -p '$remote_dir/evals/tac/scripts'"

rsync -az --delete -e "$rsync_ssh" dist "ubuntu@$host:$remote_dir/"
rsync -az -e "$rsync_ssh" \
  evals/tac/scripts/check-opentasks-mcp.mjs \
  evals/tac/scripts/start-litellm-bedrock-proxy.sh \
  "ubuntu@$host:$remote_dir/evals/tac/scripts/"
if [[ -n "${TAC_SWARM_HARNESS_TARBALL:-}" ]]; then
  if [[ ! -f "$TAC_SWARM_HARNESS_TARBALL" ]]; then
    echo "TAC_SWARM_HARNESS_TARBALL does not exist: $TAC_SWARM_HARNESS_TARBALL" >&2
    exit 2
  fi
  "${ssh_base[@]}" "mkdir -p '$remote_dir/evals/tac/artifacts'"
  rsync -az -e "$rsync_ssh" "$TAC_SWARM_HARNESS_TARBALL" "ubuntu@$host:$remote_dir/evals/tac/artifacts/swarm-harness.tgz"
fi
rsync -az -e "$rsync_ssh" "$runtime_pkg" "ubuntu@$host:$remote_dir/package.json"
rm -f "$runtime_pkg"

"${ssh_base[@]}" "set -euo pipefail
  cd '$remote_dir'
  rm -rf node_modules package-lock.json
  npm install --omit=dev --package-lock=false
  node -e 'import(\"better-sqlite3\").then(() => console.log(\"opentasks runtime ok\"))'"
