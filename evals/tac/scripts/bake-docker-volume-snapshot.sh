#!/usr/bin/env bash
set -euo pipefail

tf_dir="${TAC_POOL_TF_DIR:-infra/tac-ec2-pool}"
name="${TAC_DOCKER_SNAPSHOT_NAME:-opentasks-tac-docker-cache}"
pool_name="${TAC_DOCKER_SNAPSHOT_POOL_NAME:-${name}-builder}"
region="${TAC_POOL_REGION:-us-west-1}"
instance_type="${TAC_DOCKER_SNAPSHOT_INSTANCE_TYPE:-${TAC_POOL_INSTANCE_TYPE:-m7i.2xlarge}}"
root_volume_gb="${TAC_DOCKER_SNAPSHOT_ROOT_VOLUME_GB:-${TAC_POOL_ROOT_VOLUME_GB:-80}}"
tac_service_slice="${TAC_DOCKER_SNAPSHOT_SERVICE_SLICE:-${TAC_POOL_SERVICE_SLICE:-full}}"
snapshot_mode="${TAC_DOCKER_SNAPSHOT_MODE:-images}"
docker_volume_gb="${TAC_DOCKER_SNAPSHOT_VOLUME_GB:-${TAC_POOL_DOCKER_VOLUME_GB:-200}}"
docker_volume_iops="${TAC_DOCKER_SNAPSHOT_VOLUME_IOPS:-${TAC_POOL_DOCKER_VOLUME_IOPS:-3000}}"
docker_volume_throughput="${TAC_DOCKER_SNAPSHOT_VOLUME_THROUGHPUT:-${TAC_POOL_DOCKER_VOLUME_THROUGHPUT:-125}}"
docker_volume_device_name="${TAC_POOL_DOCKER_VOLUME_DEVICE_NAME:-/dev/sdf}"
docker_volume_mount_point="${TAC_POOL_DOCKER_VOLUME_MOUNT_POINT:-/mnt/tac-docker}"
delete_after="${TAC_POOL_DELETE_AFTER:-$(date +%F)}"
manifest="${TAC_DOCKER_SNAPSHOT_MANIFEST:-/tmp/${pool_name}-manifest.json}"
public_key_path="${TAC_POOL_PUBLIC_KEY_PATH:-}"
key_name="${TAC_POOL_KEY_NAME:-}"
ssh_key_path="${TAC_POOL_SSH_KEY_PATH:-${EC2_SSH_KEY_PATH:-}}"
allowed_cidr_blocks="${TAC_POOL_ALLOWED_CIDR_BLOCKS:-}"
bootstrap_timeout_sec="${TAC_POOL_BOOTSTRAP_TIMEOUT_SEC:-3600}"
snapshot_timeout_sec="${TAC_DOCKER_SNAPSHOT_TIMEOUT_SEC:-7200}"
keep_builder="${TAC_DOCKER_SNAPSHOT_KEEP_BUILDER:-0}"
cleanup_failed_snapshot="${TAC_DOCKER_SNAPSHOT_CLEANUP_FAILED:-1}"

if [[ -z "$allowed_cidr_blocks" ]]; then
  ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  allowed_cidr_blocks="[\"$ip/32\"]"
fi

if [[ -z "$public_key_path" && -z "$key_name" ]]; then
  if [[ -n "$ssh_key_path" && -f "${ssh_key_path}.pub" ]]; then
    public_key_path="${ssh_key_path}.pub"
  else
    echo "Set TAC_POOL_PUBLIC_KEY_PATH or TAC_POOL_KEY_NAME." >&2
    exit 2
  fi
fi

if [[ -z "$ssh_key_path" && -n "$public_key_path" && "$public_key_path" == *.pub ]]; then
  ssh_key_path="${public_key_path%.pub}"
fi

if [[ -z "$ssh_key_path" || ! -f "$ssh_key_path" ]]; then
  echo "Set TAC_POOL_SSH_KEY_PATH or EC2_SSH_KEY_PATH to the private SSH key for the builder." >&2
  exit 2
fi

tf_vars=(
  -var "region=$region"
  -var "name=$pool_name"
  -var "run_id=docker-snapshot-$(date -u +%Y-%m-%dT%H-%M-%S-%NZ)"
  -var "worker_count=1"
  -var "instance_type=$instance_type"
  -var "root_volume_gb=$root_volume_gb"
  -var "tac_service_slice=$tac_service_slice"
  -var "docker_volume_enabled=true"
  -var "docker_volume_gb=$docker_volume_gb"
  -var "docker_volume_iops=$docker_volume_iops"
  -var "docker_volume_throughput=$docker_volume_throughput"
  -var "docker_volume_device_name=$docker_volume_device_name"
  -var "docker_volume_mount_point=$docker_volume_mount_point"
  -var "bootstrap_tac=true"
  -var "allowed_cidr_blocks=$allowed_cidr_blocks"
  -var "delete_after=$delete_after"
)

if [[ -n "$public_key_path" ]]; then
  tf_vars+=(-var "public_key_path=$public_key_path")
fi
if [[ -n "$key_name" ]]; then
  tf_vars+=(-var "key_name=$key_name")
fi

applied=0
cleanup() {
  status=$?
  if [[ "$applied" != "1" ]]; then
    exit "$status"
  fi
  if [[ "$keep_builder" == "1" || "$keep_builder" == "true" ]]; then
    echo "TAC_DOCKER_SNAPSHOT_KEEP_BUILDER=$keep_builder; leaving builder running."
    exit "$status"
  fi
  terraform -chdir="$tf_dir" destroy -auto-approve "${tf_vars[@]}" >/dev/null || {
    echo "WARNING: builder destroy failed; inspect $tf_dir state manually." >&2
    exit 1
  }
  exit "$status"
}
trap cleanup EXIT

wait_for_snapshot() {
  local snapshot_id="$1"
  local deadline=$((SECONDS + snapshot_timeout_sec))
  local state progress
  while (( SECONDS < deadline )); do
    state="$(aws --region "$region" ec2 describe-snapshots \
      --snapshot-ids "$snapshot_id" \
      --query 'Snapshots[0].State' \
      --output text 2>/dev/null || echo missing)"
    progress="$(aws --region "$region" ec2 describe-snapshots \
      --snapshot-ids "$snapshot_id" \
      --query 'Snapshots[0].Progress' \
      --output text 2>/dev/null || true)"
    echo "Snapshot $snapshot_id state=$state progress=$progress"
    case "$state" in
      completed)
        return 0
        ;;
      error|missing)
        return 1
        ;;
    esac
    sleep 30
  done
  return 1
}

terraform -chdir="$tf_dir" init
applied=1
terraform -chdir="$tf_dir" apply -auto-approve "${tf_vars[@]}"
terraform -chdir="$tf_dir" output -json runner_manifest > "$manifest"

instance_id="$(jq -r '.workers[0].id' "$manifest")"
ip="$(jq -r '.workers[0].public_ip' "$manifest")"
docker_volume_id="$(jq -r '.workers[0].docker_volume_id // empty' "$manifest")"

if [[ -z "$docker_volume_id" || "$docker_volume_id" == "null" ]]; then
  echo "Terraform manifest did not include a Docker volume id." >&2
  exit 1
fi

echo "Waiting for TAC Docker-cache builder $ip bootstrap..."
deadline=$((SECONDS + bootstrap_timeout_sec))
while (( SECONDS < deadline )); do
  healthcheck_script='
    set -e
    cloud-init status --wait >/dev/null
    cloud-init status | grep -q "status: done"
    case "'"$tac_service_slice"'" in
      gitlab)
        curl -fsS http://127.0.0.1:2999/api/healthcheck/gitlab >/dev/null
        ;;
      full)
        curl -fsS http://127.0.0.1:2999/api/healthcheck/gitlab >/dev/null
        curl -fsS http://127.0.0.1:2999/api/healthcheck/owncloud >/dev/null
        curl -fsS http://127.0.0.1:2999/api/healthcheck/rocketchat >/dev/null
        curl -fsS http://127.0.0.1:2999/api/healthcheck/plane >/dev/null
        ;;
      *)
        echo "Unsupported TAC service slice: '"$tac_service_slice"'" >&2
        exit 2
        ;;
    esac
  '
  if ssh -o BatchMode=yes \
    -n \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -i "$ssh_key_path" \
    "ubuntu@$ip" \
    "$healthcheck_script" >/dev/null 2>&1; then
    break
  fi
  sleep 30
done

if (( SECONDS >= deadline )); then
  echo "Timed out waiting for TAC Docker-cache builder bootstrap." >&2
  exit 1
fi

echo "Stopping Docker on builder before snapshot..."
case "$snapshot_mode" in
  images)
    cleanup_script='set -euo pipefail
      sudo docker rm -f $(sudo docker ps -aq) >/dev/null 2>&1 || true
      sudo docker volume rm $(sudo docker volume ls -q) >/dev/null 2>&1 || true
      sudo docker network prune -f >/dev/null 2>&1 || true
      sudo docker system df
      sudo systemctl stop docker
      sudo sync'
    ;;
  services)
    cleanup_script='set -euo pipefail
      sudo docker stop $(sudo docker ps -aq) >/dev/null 2>&1 || true
      sudo docker rm -f $(sudo docker ps -aq) >/dev/null 2>&1 || true
      sudo docker network prune -f >/dev/null 2>&1 || true
      sudo docker system df
      sudo systemctl stop docker
      sudo sync'
    ;;
  *)
    echo "Unsupported TAC_DOCKER_SNAPSHOT_MODE=$snapshot_mode; expected images or services." >&2
    exit 2
    ;;
esac

ssh -o BatchMode=yes \
  -n \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -i "$ssh_key_path" \
  "ubuntu@$ip" \
  "$cleanup_script"

snapshot_name="${name}-$(date -u +%Y%m%d%H%M%S)"
echo "Creating Docker volume snapshot $snapshot_name from $docker_volume_id..."
snapshot_id="$(aws --region "$region" ec2 create-snapshot \
  --volume-id "$docker_volume_id" \
  --description "OpenTasks TAC Docker $snapshot_mode snapshot ($tac_service_slice) from $instance_id" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=Project,Value=opentasks},{Key=Purpose,Value=tac-docker-cache},{Key=Name,Value=$snapshot_name},{Key=SnapshotMode,Value=$snapshot_mode},{Key=ServiceSlice,Value=$tac_service_slice}]" \
  --query SnapshotId \
  --output text)"

if ! wait_for_snapshot "$snapshot_id"; then
  echo "Snapshot $snapshot_id did not complete within ${snapshot_timeout_sec}s." >&2
  if [[ "$cleanup_failed_snapshot" == "1" || "$cleanup_failed_snapshot" == "true" ]]; then
    aws --region "$region" ec2 delete-snapshot --snapshot-id "$snapshot_id" >/dev/null 2>&1 || true
  fi
  exit 1
fi

echo "$snapshot_id"
echo "Use with: TAC_POOL_DOCKER_VOLUME_ENABLED=1 TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID=$snapshot_id evals/tac/scripts/run-ec2-pool.sh"
