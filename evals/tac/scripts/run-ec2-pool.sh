#!/usr/bin/env bash
set -euo pipefail

tf_dir="${TAC_POOL_TF_DIR:-infra/tac-ec2-pool}"
name="${TAC_POOL_NAME:-opentasks-tac-pool}"
run_id="${TAC_POOL_RUN_ID:-tac-pool-$(date -u +%Y-%m-%dT%H-%M-%S-%NZ)}"
region="${TAC_POOL_REGION:-us-west-1}"
subnet_id="${TAC_POOL_SUBNET_ID:-}"
worker_count="${TAC_POOL_WORKER_COUNT:-2}"
instance_type="${TAC_POOL_INSTANCE_TYPE:-m7i.2xlarge}"
root_volume_gb="${TAC_POOL_ROOT_VOLUME_GB:-200}"
tac_service_slice="${TAC_POOL_SERVICE_SLICE:-full}"
docker_volume_enabled="${TAC_POOL_DOCKER_VOLUME_ENABLED:-0}"
docker_volume_gb="${TAC_POOL_DOCKER_VOLUME_GB:-200}"
docker_volume_iops="${TAC_POOL_DOCKER_VOLUME_IOPS:-3000}"
docker_volume_throughput="${TAC_POOL_DOCKER_VOLUME_THROUGHPUT:-125}"
docker_volume_snapshot_id="${TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID:-}"
docker_volume_device_name="${TAC_POOL_DOCKER_VOLUME_DEVICE_NAME:-/dev/sdf}"
docker_volume_mount_point="${TAC_POOL_DOCKER_VOLUME_MOUNT_POINT:-/mnt/tac-docker}"
delete_after="${TAC_POOL_DELETE_AFTER:-$(date +%F)}"
manifest="${TAC_POOL_MANIFEST_OUT:-/tmp/${name}-manifest.json}"
ami_id="${TAC_POOL_AMI_ID:-}"
bootstrap_tac="${TAC_POOL_BOOTSTRAP_TAC:-}"
public_key_path="${TAC_POOL_PUBLIC_KEY_PATH:-}"
key_name="${TAC_POOL_KEY_NAME:-}"
ssh_key_path="${TAC_POOL_SSH_KEY_PATH:-${EC2_SSH_KEY_PATH:-}}"
allowed_cidr_blocks="${TAC_POOL_ALLOWED_CIDR_BLOCKS:-}"
keep_workers="${TAC_POOL_KEEP_WORKERS:-0}"
sync_opentasks="${TAC_POOL_SYNC_OPENTASKS:-1}"
wait_bootstrap="${TAC_POOL_WAIT_BOOTSTRAP:-1}"
bootstrap_timeout_sec="${TAC_POOL_BOOTSTRAP_TIMEOUT_SEC:-2400}"
create_results_bucket="${TAC_POOL_CREATE_RESULTS_BUCKET:-0}"
results_retention_days="${TAC_POOL_RESULTS_RETENTION_DAYS:-14}"
max_workers="${TAC_POOL_MAX_WORKERS:-32}"
verify_destroy="${TAC_POOL_VERIFY_DESTROY:-1}"
skip_llm_auth_check="${TAC_POOL_SKIP_LLM_AUTH_CHECK:-0}"

export TAC_POOL_RUN_ID="$run_id"

if [[ "$worker_count" -gt "$max_workers" ]]; then
  echo "Refusing to launch $worker_count workers; TAC_POOL_MAX_WORKERS=$max_workers." >&2
  exit 2
fi

if [[ -z "$bootstrap_tac" ]]; then
  if [[ -n "$ami_id" ]]; then
    bootstrap_tac="false"
  else
    bootstrap_tac="true"
  fi
fi

tf_bool() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) echo "true" ;;
    0|false|FALSE|no|NO|off|OFF) echo "false" ;;
    *)
      echo "Invalid boolean value: $1" >&2
      exit 2
      ;;
  esac
}

bootstrap_tac="$(tf_bool "$bootstrap_tac")"
create_results_bucket="$(tf_bool "$create_results_bucket")"
docker_volume_enabled="$(tf_bool "$docker_volume_enabled")"

if [[ -z "$allowed_cidr_blocks" ]]; then
  ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  allowed_cidr_blocks="[\"$ip/32\"]"
fi

if [[ -z "$public_key_path" && -z "$key_name" ]]; then
  if [[ -n "$ssh_key_path" && -f "${ssh_key_path}.pub" ]]; then
    public_key_path="${ssh_key_path}.pub"
  else
    echo "Set TAC_POOL_PUBLIC_KEY_PATH or TAC_POOL_KEY_NAME." >&2
    echo "Set TAC_POOL_SSH_KEY_PATH/EC2_SSH_KEY_PATH for runtime SSH access." >&2
    exit 2
  fi
fi

if [[ -z "$ssh_key_path" ]]; then
  if [[ -n "$public_key_path" && "$public_key_path" == *.pub ]]; then
    ssh_key_path="${public_key_path%.pub}"
  fi
fi

if [[ -z "$ssh_key_path" || ! -f "$ssh_key_path" ]]; then
  echo "Set TAC_POOL_SSH_KEY_PATH or EC2_SSH_KEY_PATH to the private SSH key for the pool." >&2
  exit 2
fi

if [[ "$skip_llm_auth_check" != "1" && "$skip_llm_auth_check" != "true" ]]; then
  eval_model="${EVAL_MODEL:-haiku}"
  model_has_remote_auth=0
  model_auth_error=""

  if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    model_has_remote_auth=1
  elif [[ "${CLAUDE_CODE_USE_BEDROCK:-}" == "1" ]]; then
    if [[ -z "${AWS_REGION:-}" ]]; then
      model_auth_error="CLAUDE_CODE_USE_BEDROCK=1 requires AWS_REGION for EC2 TAC runs."
    elif [[ -z "${AWS_BEARER_TOKEN_BEDROCK:-}" && -z "${AWS_ACCESS_KEY_ID:-}" && -z "${AWS_PROFILE:-}" ]]; then
      model_auth_error="CLAUDE_CODE_USE_BEDROCK=1 requires AWS_BEARER_TOKEN_BEDROCK, AWS_ACCESS_KEY_ID, or AWS_PROFILE for EC2 TAC runs."
    else
      model_has_remote_auth=1
    fi
  elif [[ "$eval_model" =~ ^(azureoai/) ]]; then
    if [[ -z "${AZURE_OPENAI_API_KEY:-${AZURE_OPENAI_KEY:-${AZURE_API_KEY:-}}}" ]]; then
      model_auth_error="Azure OpenAI TAC runs require AZURE_OPENAI_API_KEY, AZURE_OPENAI_KEY, or AZURE_API_KEY."
    elif [[ -z "${AZURE_OPENAI_ENDPOINT:-${AZURE_OPENAI_BASE_URL:-${AZURE_API_BASE:-}}}" ]]; then
      model_auth_error="Azure OpenAI TAC runs require AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_BASE_URL, or AZURE_API_BASE."
    else
      model_has_remote_auth=1
    fi
  elif [[ "$eval_model" =~ ^(gpt|o[134]|openai/) ]]; then
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      model_has_remote_auth=1
    else
      model_auth_error="OpenAI TAC runs require OPENAI_API_KEY."
    fi
  elif [[ "$eval_model" =~ ^(litellm/|gateway/|azure/|bedrock/) ]]; then
    if [[ -n "${LITELLM_API_KEY:-}" && -n "${LITELLM_BASE_URL:-}" ]]; then
      model_has_remote_auth=1
    else
      model_auth_error="LiteLLM/gateway TAC runs require LITELLM_API_KEY and LITELLM_BASE_URL."
    fi
  fi

  if [[ "$model_has_remote_auth" != "1" ]]; then
    echo "EC2 TAC runs need remote-usable model auth for EVAL_MODEL=${eval_model}." >&2
    if [[ -n "$model_auth_error" ]]; then
      echo "$model_auth_error" >&2
    else
      echo "Set ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN, Bedrock Claude env, Azure/OpenAI env, or LiteLLM gateway env for the selected model." >&2
    fi
    echo "Set TAC_POOL_SKIP_LLM_AUTH_CHECK=1 only for environment-only canaries." >&2
    exit 2
  fi
fi

tf_vars=(
  -var "region=$region"
  -var "name=$name"
  -var "run_id=$run_id"
  -var "worker_count=$worker_count"
  -var "instance_type=$instance_type"
  -var "subnet_id=$subnet_id"
  -var "root_volume_gb=$root_volume_gb"
  -var "tac_service_slice=$tac_service_slice"
  -var "docker_volume_enabled=$docker_volume_enabled"
  -var "docker_volume_gb=$docker_volume_gb"
  -var "docker_volume_iops=$docker_volume_iops"
  -var "docker_volume_throughput=$docker_volume_throughput"
  -var "docker_volume_device_name=$docker_volume_device_name"
  -var "docker_volume_mount_point=$docker_volume_mount_point"
  -var "bootstrap_tac=$bootstrap_tac"
  -var "allowed_cidr_blocks=$allowed_cidr_blocks"
  -var "delete_after=$delete_after"
  -var "create_results_bucket=$create_results_bucket"
  -var "results_retention_days=$results_retention_days"
)

if [[ -n "$ami_id" ]]; then
  tf_vars+=(-var "ami_id=$ami_id")
fi
if [[ -n "$docker_volume_snapshot_id" ]]; then
  tf_vars+=(-var "docker_volume_snapshot_id=$docker_volume_snapshot_id")
fi
if [[ -n "$public_key_path" ]]; then
  tf_vars+=(-var "public_key_path=$public_key_path")
fi
if [[ -n "$key_name" ]]; then
  tf_vars+=(-var "key_name=$key_name")
fi

applied=0
verify_destroyed() {
  if [[ "$verify_destroy" != "1" && "$verify_destroy" != "true" ]]; then
    return 0
  fi
  if [[ ! -f "$manifest" ]] || ! command -v aws >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "Skipping post-destroy verification; manifest, aws, or jq is unavailable." >&2
    return 0
  fi

  local instance_ids docker_volume_ids security_group_id key_pair_name generated_key states volume_status sg_status key_status
  instance_ids="$(jq -r '.workers[]?.id' "$manifest" | tr '\n' ' ')"
  docker_volume_ids="$(jq -r '.workers[]?.docker_volume_id // empty' "$manifest" | tr '\n' ' ')"
  security_group_id="$(jq -r '.security_group_id // empty' "$manifest")"
  key_pair_name="$(jq -r '.key_pair_name // empty' "$manifest")"
  generated_key="$(jq -r '.generated_key // false' "$manifest")"

  if [[ -n "${instance_ids// }" ]]; then
    states="$(aws --region "$region" ec2 describe-instances \
      --instance-ids $instance_ids \
      --query 'Reservations[].Instances[].State.Name' \
      --output text 2>/dev/null || true)"
    if echo "$states" | tr '\t' '\n' | awk 'NF > 0 && $0 != "terminated" { found = 1 } END { exit found ? 0 : 1 }'; then
      echo "WARNING: post-destroy verification found non-terminated instances: $states" >&2
      return 1
    fi
  fi

  if [[ -n "${docker_volume_ids// }" ]]; then
    volume_status="$(aws --region "$region" ec2 describe-volumes \
      --volume-ids $docker_volume_ids \
      --query 'Volumes[].State' \
      --output text 2>&1 || true)"
    if [[ "$volume_status" != *"InvalidVolume.NotFound"* && -n "${volume_status// }" ]]; then
      echo "WARNING: Docker EBS volumes still appear to exist: $docker_volume_ids ($volume_status)" >&2
      return 1
    fi
  fi

  if [[ -n "$security_group_id" ]]; then
    sg_status="$(aws --region "$region" ec2 describe-security-groups --group-ids "$security_group_id" --output text 2>&1 || true)"
    if [[ "$sg_status" != *"InvalidGroup.NotFound"* && "$sg_status" != *"InvalidGroup.NotFoundException"* ]]; then
      echo "WARNING: security group still appears to exist: $security_group_id" >&2
      return 1
    fi
  fi

  if [[ "$generated_key" == "true" && -n "$key_pair_name" ]]; then
    key_status="$(aws --region "$region" ec2 describe-key-pairs --key-names "$key_pair_name" --output text 2>&1 || true)"
    if [[ "$key_status" != *"InvalidKeyPair.NotFound"* && "$key_status" != *"InvalidKeyPair.NotFoundException"* ]]; then
      echo "WARNING: generated key pair still appears to exist: $key_pair_name" >&2
      return 1
    fi
  fi

  echo "Post-destroy verification passed."
}

cleanup() {
  status=$?
  if [[ "$applied" != "1" ]]; then
    exit "$status"
  fi
  if [[ "$keep_workers" == "1" || "$keep_workers" == "true" ]]; then
    echo "TAC_POOL_KEEP_WORKERS=$keep_workers; leaving EC2 pool running."
    echo "Cleanup later with: terraform -chdir=$tf_dir destroy -auto-approve ${tf_vars[*]}"
    exit "$status"
  fi
  echo "Destroying EC2 pool by default. Set TAC_POOL_KEEP_WORKERS=1 to keep it."
  terraform -chdir="$tf_dir" destroy -auto-approve "${tf_vars[@]}" || {
    echo "WARNING: terraform destroy failed; inspect $tf_dir state manually." >&2
    exit 1
  }
  verify_destroyed || exit 1
  exit "$status"
}
trap cleanup EXIT

terraform -chdir="$tf_dir" init
applied=1
terraform -chdir="$tf_dir" apply -auto-approve "${tf_vars[@]}"
terraform -chdir="$tf_dir" output -json runner_manifest > "$manifest"

if [[ -z "${TAC_POOL_RESULTS_S3_URI:-}" ]]; then
  results_bucket="$(jq -r '.results_bucket // empty' "$manifest")"
  if [[ -n "$results_bucket" ]]; then
    export TAC_POOL_RESULTS_S3_URI="s3://$results_bucket"
  fi
fi

wait_for_worker() {
  local ip="$1"
  local deadline=$((SECONDS + bootstrap_timeout_sec))
  local healthcheck_script
  echo "Waiting for TAC worker $ip bootstrap..."
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
      echo "Worker $ip is ready."
      return 0
    fi
    sleep 30
  done
  echo "Timed out waiting for TAC worker $ip bootstrap." >&2
  return 1
}

if [[ "$wait_bootstrap" == "1" || "$wait_bootstrap" == "true" ]]; then
  while read -r ip; do
    wait_for_worker "$ip"
  done < <(jq -r '.workers[].public_ip' "$manifest")
fi

if [[ "$sync_opentasks" == "1" || "$sync_opentasks" == "true" ]]; then
  while read -r ip; do
    evals/tac/scripts/sync-opentasks-ec2.sh "$ip" "$ssh_key_path"
  done < <(jq -r '.workers[].public_ip' "$manifest")
fi

TAC_POOL_MANIFEST="$manifest" \
EC2_SSH_KEY_PATH="$ssh_key_path" \
npx tsx evals/tac/run-pool.ts
