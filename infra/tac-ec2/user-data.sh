#!/bin/bash
set -euxo pipefail

exec > >(tee -a /var/log/opentasks-tac-bootstrap.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git jq make

curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu || true
chmod 666 /var/run/docker.sock

mkdir -p /opt
if [ ! -d /opt/TheAgentCompany ]; then
  git clone --depth 1 https://github.com/TheAgentCompany/TheAgentCompany.git /opt/TheAgentCompany
fi

cd /opt/TheAgentCompany/servers

# TAC's setup.sh pulls bitnamilegacy/mongodb:5.0, but the API server image's
# embedded compose file still references bitnami/mongodb:5.0 during start-all.
# Pre-alias it so the inner compose startup does not fail and silently strand
# api-server before port 2999 starts listening.
docker pull bitnamilegacy/mongodb:5.0
docker tag bitnamilegacy/mongodb:5.0 bitnami/mongodb:5.0

bash setup.sh
