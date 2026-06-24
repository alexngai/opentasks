#!/bin/bash
set -euxo pipefail

exec > >(tee -a /var/log/opentasks-tac-worker-bootstrap.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

mount_docker_volume() {
  if [ "${docker_volume_enabled}" != "true" ]; then
    return 0
  fi

  local requested="${docker_volume_device_name}"
  local mount_point="${docker_volume_mount_point}"
  local device=""
  local suffix=""
  suffix="$${requested#/dev/sd}"

  echo "Waiting for Docker data volume..."
  for _ in $(seq 1 120); do
    for candidate in "$requested" "/dev/xvd$suffix" /dev/nvme1n1 /dev/nvme2n1 /dev/nvme3n1; do
      if [ -b "$candidate" ]; then
        device="$candidate"
        break
      fi
    done
    if [ -n "$device" ]; then
      break
    fi
    sleep 2
  done

  if [ -z "$device" ]; then
    echo "Could not find Docker data volume for requested device $requested" >&2
    lsblk
    exit 1
  fi

  echo "Using Docker data volume $device at $mount_point"
  systemctl stop docker || true
  mkdir -p "$mount_point"
  if ! blkid "$device" >/dev/null 2>&1; then
    mkfs.ext4 -F "$device"
  fi
  local uuid
  uuid="$(blkid -s UUID -o value "$device")"
  if ! grep -q "UUID=$uuid " /etc/fstab; then
    echo "UUID=$uuid $mount_point ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
  mount "$mount_point"

  mkdir -p "$mount_point/docker" "$mount_point/containerd"
  mkdir -p /var/lib/docker /var/lib/containerd
  if ! grep -q "$mount_point/docker /var/lib/docker " /etc/fstab; then
    echo "$mount_point/docker /var/lib/docker none bind,nofail 0 0" >> /etc/fstab
  fi
  if ! grep -q "$mount_point/containerd /var/lib/containerd " /etc/fstab; then
    echo "$mount_point/containerd /var/lib/containerd none bind,nofail 0 0" >> /etc/fstab
  fi
  mount /var/lib/docker
  mount /var/lib/containerd
}

mount_docker_volume

if [ "${bootstrap_tac}" != "true" ]; then
  systemctl daemon-reload || true
  systemctl start docker || true
  exit 0
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg jq make rsync build-essential

curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu || true
chmod 666 /var/run/docker.sock

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

mkdir -p /home/ubuntu/opentasks
chown -R ubuntu:ubuntu /home/ubuntu/opentasks

mkdir -p /opt
if [ ! -d /opt/TheAgentCompany ]; then
  git clone --depth 1 https://github.com/TheAgentCompany/TheAgentCompany.git /opt/TheAgentCompany
fi

cd /opt/TheAgentCompany/servers

start_api_server_skip_setup() {
  docker stop api-server || true
  docker rm -f api-server || true
  docker run -d \
    --name api-server \
    --network host \
    --restart always \
    -e SKIP_SETUP=True \
    -v /var/run/docker.sock:/var/run/docker.sock \
    ghcr.io/theagentcompany/servers-api-server:${tac_version}
}

find_docker_volume_containing() {
  local marker="$1"
  local name
  local mount_point

  while read -r name; do
    mount_point="$(docker volume inspect "$name" --format '{{ .Mountpoint }}' 2>/dev/null || true)"
    if [ -n "$mount_point" ] && [ -e "$mount_point/$marker" ]; then
      echo "$name"
      return 0
    fi
  done < <(docker volume ls -q)

  return 1
}

gitlab_preseeded_volume_args() {
  local etc_volume=""
  local data_volume=""
  local logs_volume=""

  etc_volume="$(find_docker_volume_containing gitlab.rb || true)"
  data_volume="$(find_docker_volume_containing gitlab-rails || true)"
  logs_volume="$(find_docker_volume_containing reconfigure || true)"

  if [ -n "$etc_volume" ] && [ -n "$data_volume" ] && [ -n "$logs_volume" ]; then
    echo "Reusing preseeded GitLab volumes: etc=$etc_volume data=$data_volume logs=$logs_volume" >&2
    printf '%s\n' \
      "-v" "$etc_volume:/etc/gitlab" \
      "-v" "$data_volume:/var/opt/gitlab" \
      "-v" "$logs_volume:/var/log/gitlab"
    return 0
  fi

  echo "No complete preseeded GitLab volume set found; Docker will create and copy anonymous volumes." >&2
  return 1
}

start_gitlab_direct() {
  local volume_args=()
  docker rm -f gitlab || true
  if mapfile -t volume_args < <(gitlab_preseeded_volume_args); then
    :
  else
    volume_args=()
  fi
  docker run -d \
    --name gitlab \
    --hostname the-agent-company.com \
    --restart always \
    --shm-size 256m \
    "$${volume_args[@]}" \
    -e GITLAB_OMNIBUS_CONFIG="external_url 'http://the-agent-company.com:8929'; gitlab_rails['gitlab_shell_ssh_port'] = 2424" \
    -p 8929:8929 \
    -p 8930:443 \
    -p 2424:22 \
    ghcr.io/theagentcompany/servers-gitlab:${tac_version}
}

wait_for_healthcheck() {
  local service="$1"
  local attempts="$${2:-180}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "http://127.0.0.1:2999/api/healthcheck/$service" >/dev/null; then
      echo "$service is ready"
      return 0
    fi
    echo "Waiting for $service..."
    sleep 10
  done
  echo "Timed out waiting for $service" >&2
  return 1
}

docker pull ghcr.io/theagentcompany/servers-api-server:${tac_version}
docker pull ghcr.io/theagentcompany/servers-gitlab:${tac_version}

case "${tac_service_slice}" in
  gitlab)
    start_api_server_skip_setup
    start_gitlab_direct
    wait_for_healthcheck gitlab
    ;;
  full)
    # TAC's setup.sh pulls bitnamilegacy/mongodb:5.0, but the API server image's
    # embedded compose file still references bitnami/mongodb:5.0 during start-all.
    docker pull bitnamilegacy/mongodb:5.0
    docker tag bitnamilegacy/mongodb:5.0 bitnami/mongodb:5.0
    bash setup.sh
    ;;
  *)
    echo "Unsupported TAC service slice: ${tac_service_slice}" >&2
    exit 2
    ;;
esac

docker pull ghcr.io/theagentcompany/sde-add-one-gitlab-pipeline-image:${tac_version} || true
