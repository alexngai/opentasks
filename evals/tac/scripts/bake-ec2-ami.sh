#!/usr/bin/env bash
set -euo pipefail

tf_dir="${TAC_POOL_TF_DIR:-infra/tac-ec2-pool}"
name="${TAC_AMI_BAKE_NAME:-opentasks-tac-worker-ami}"
pool_name="${TAC_AMI_BAKE_POOL_NAME:-${name}-builder}"
region="${TAC_POOL_REGION:-us-west-1}"
instance_type="${TAC_AMI_BAKE_INSTANCE_TYPE:-${TAC_POOL_INSTANCE_TYPE:-m7i.2xlarge}}"
root_volume_gb="${TAC_AMI_BAKE_ROOT_VOLUME_GB:-${TAC_POOL_ROOT_VOLUME_GB:-200}}"
delete_after="${TAC_POOL_DELETE_AFTER:-$(date +%F)}"
manifest="${TAC_AMI_BAKE_MANIFEST:-/tmp/${pool_name}-manifest.json}"
public_key_path="${TAC_POOL_PUBLIC_KEY_PATH:-}"
key_name="${TAC_POOL_KEY_NAME:-}"
ssh_key_path="${TAC_POOL_SSH_KEY_PATH:-${EC2_SSH_KEY_PATH:-}}"
allowed_cidr_blocks="${TAC_POOL_ALLOWED_CIDR_BLOCKS:-}"
bootstrap_timeout_sec="${TAC_POOL_BOOTSTRAP_TIMEOUT_SEC:-3600}"
keep_builder="${TAC_AMI_BAKE_KEEP_BUILDER:-0}"
image_timeout_sec="${TAC_AMI_BAKE_IMAGE_TIMEOUT_SEC:-7200}"
cleanup_failed_image="${TAC_AMI_BAKE_CLEANUP_FAILED_IMAGE:-1}"

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
  -var "run_id=ami-bake-$(date -u +%Y-%m-%dT%H-%M-%S-%NZ)"
  -var "worker_count=1"
  -var "instance_type=$instance_type"
  -var "root_volume_gb=$root_volume_gb"
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
    echo "TAC_AMI_BAKE_KEEP_BUILDER=$keep_builder; leaving builder running."
    exit "$status"
  fi
  terraform -chdir="$tf_dir" destroy -auto-approve "${tf_vars[@]}" >/dev/null || {
    echo "WARNING: builder destroy failed; inspect $tf_dir state manually." >&2
    exit 1
  }
  exit "$status"
}
trap cleanup EXIT

cleanup_image() {
  local image_id="$1"
  local snapshot_ids
  if [[ "$cleanup_failed_image" != "1" && "$cleanup_failed_image" != "true" ]]; then
    return 0
  fi
  snapshot_ids="$(aws --region "$region" ec2 describe-images \
    --image-ids "$image_id" \
    --query 'Images[].BlockDeviceMappings[].Ebs.SnapshotId' \
    --output text 2>/dev/null || true)"
  aws --region "$region" ec2 deregister-image --image-id "$image_id" >/dev/null 2>&1 || true
  for snapshot_id in $snapshot_ids; do
    aws --region "$region" ec2 delete-snapshot --snapshot-id "$snapshot_id" >/dev/null 2>&1 || true
  done
}

wait_for_image() {
  local image_id="$1"
  local deadline=$((SECONDS + image_timeout_sec))
  local state
  while (( SECONDS < deadline )); do
    state="$(aws --region "$region" ec2 describe-images \
      --image-ids "$image_id" \
      --query 'Images[0].State' \
      --output text 2>/dev/null || echo missing)"
    echo "AMI $image_id state=$state"
    case "$state" in
      available)
        return 0
        ;;
      failed|missing)
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
source_ami="$(jq -r '.ami_id' "$manifest")"

echo "Waiting for TAC builder $ip bootstrap..."
deadline=$((SECONDS + bootstrap_timeout_sec))
while (( SECONDS < deadline )); do
  if ssh -o BatchMode=yes \
    -n \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -i "$ssh_key_path" \
    "ubuntu@$ip" \
    'cloud-init status --wait >/dev/null && cloud-init status | grep -q "status: done" &&
     curl -fsS http://127.0.0.1:2999/api/healthcheck/gitlab >/dev/null &&
     curl -fsS http://127.0.0.1:2999/api/healthcheck/owncloud >/dev/null &&
     curl -fsS http://127.0.0.1:2999/api/healthcheck/rocketchat >/dev/null &&
     curl -fsS http://127.0.0.1:2999/api/healthcheck/plane >/dev/null' >/dev/null 2>&1; then
    break
  fi
  sleep 30
done

if (( SECONDS >= deadline )); then
  echo "Timed out waiting for TAC builder bootstrap." >&2
  exit 1
fi

ami_name="${name}-$(date -u +%Y%m%d%H%M%S)"
echo "Stopping builder $instance_id before AMI creation..."
aws --region "$region" ec2 stop-instances --instance-ids "$instance_id" >/dev/null
aws --region "$region" ec2 wait instance-stopped --instance-ids "$instance_id"

echo "Creating AMI $ami_name from $instance_id..."
ami_id="$(aws --region "$region" ec2 create-image \
  --instance-id "$instance_id" \
  --name "$ami_name" \
  --description "OpenTasks TAC worker AMI baked from $source_ami" \
  --tag-specifications "ResourceType=image,Tags=[{Key=Project,Value=opentasks},{Key=Purpose,Value=tac-worker-ami},{Key=SourceAmi,Value=$source_ami}]" \
  --query ImageId \
  --output text)"
if ! wait_for_image "$ami_id"; then
  echo "AMI $ami_id did not become available within ${image_timeout_sec}s; cleaning it up." >&2
  cleanup_image "$ami_id"
  exit 1
fi

echo "$ami_id"
echo "Use with: TAC_POOL_AMI_ID=$ami_id TAC_POOL_BOOTSTRAP_TAC=false evals/tac/scripts/run-ec2-pool.sh"
