# TAC EC2 Worker Pool

Terraform for a disposable TheAgentCompany worker pool.

Each worker is a full TAC service host. The eval runner should use at most one
active TAC cell per worker because TAC reset/init mutates shared service state.
Scale by increasing `worker_count`, not by increasing per-worker cell
concurrency.

## Run With Default Cleanup

The safest entrypoint is the wrapper script. It provisions the pool, writes the
runner manifest, syncs OpenTasks to each worker, runs the sharded eval, and
destroys the EC2 pool on exit.

```bash
TAC_POOL_WORKER_COUNT=4 \
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2 \
EVAL_MODEL=haiku EVAL_ARMS=stock,notes,opentasks \
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=12 \
evals/tac/scripts/run-ec2-pool.sh
```

Leave workers running for debugging or reuse:

```bash
TAC_POOL_KEEP_WORKERS=1 evals/tac/scripts/run-ec2-pool.sh
```

The wrapper tags resources with `TAC_POOL_RUN_ID`, enforces
`TAC_POOL_MAX_WORKERS` (default `32`), destroys the pool on exit, and verifies
that instances, generated key pairs, and the security group are gone after
destroy. Set `TAC_POOL_KEEP_WORKERS=1` to skip destroy or
`TAC_POOL_VERIFY_DESTROY=0` to skip AWS CLI verification.

Set per-cell guardrails such as `TAC_CELL_TIMEOUT_SEC`,
`TAC_CELL_MAX_TOKENS`, and `TAC_CELL_MAX_OUTPUT_BYTES` before larger TAC
rounds. Budgeted cells are terminal `budget_exceeded` outcomes, not env errors,
so they do not trigger infra retries or worker quarantine.

## Baked Worker AMI

The default Terraform path starts from Ubuntu and runs the full TAC bootstrap in
cloud-init. For repeated benchmark rounds, bake that once:

```bash
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
npm run eval:tac:pool:bake-ami
```

Then run the pool from the baked image:

```bash
TAC_POOL_AMI_ID=ami-... \
TAC_POOL_BOOTSTRAP_TAC=false \
TAC_POOL_WORKER_COUNT=8 \
evals/tac/scripts/run-ec2-pool.sh
```

When `TAC_POOL_AMI_ID` is set, the wrapper defaults
`TAC_POOL_BOOTSTRAP_TAC=false`.

## Docker Volume Cache

The preferred repeated-run optimization is a small root volume plus a separate
Docker data volume:

```text
root volume: 40-80 GiB
  OS, Docker engine, Node, TAC repo, OpenTasks runtime

Docker volume: 150-250 GiB mounted at /mnt/tac-docker
  /var/lib/docker and /var/lib/containerd bind-mounted into the volume
  Docker image layers, TAC task images, containers, Docker volumes, containerd state
```

The Docker snapshot bake cleans out live containers, Docker volumes, and
networks before snapshotting. Treat the snapshot as an image/containerd cache,
not as a runnable checkpoint of already-started TAC services.

Bake a reusable Docker cache snapshot:

```bash
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
npm run eval:tac:pool:bake-docker-snapshot
```

Run workers from that snapshot:

```bash
TAC_POOL_DOCKER_VOLUME_ENABLED=1 \
TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID=snap-... \
TAC_POOL_SERVICE_SLICE=gitlab \
TAC_POOL_ROOT_VOLUME_GB=80 \
TAC_POOL_DOCKER_VOLUME_GB=200 \
TAC_POOL_DOCKER_VOLUME_IOPS=16000 \
TAC_POOL_DOCKER_VOLUME_THROUGHPUT=1000 \
TAC_POOL_WORKER_COUNT=8 \
evals/tac/scripts/run-ec2-pool.sh
```

The root AMI can still be the stock Ubuntu AMI. With `bootstrap_tac=true`, the
worker installs Docker and reruns TAC setup, but most image pulls should hit the
preloaded Docker/containerd snapshot. This avoids baking a 200 GiB root AMI and
keeps cleanup simple because the Docker EBS volume is deleted with the worker.
For snapshot-backed startup tests, enable Fast Snapshot Restore in the worker AZ;
otherwise first access to cached image layers can dominate startup time.

For GitLab-only task slices, set `TAC_POOL_SERVICE_SLICE=gitlab`. The worker
starts only the TAC API server and GitLab, and readiness checks only GitLab.
The default `full` slice starts GitLab, OwnCloud, RocketChat, and Plane. Docker
snapshot bakes also support `TAC_DOCKER_SNAPSHOT_SERVICE_SLICE=gitlab`.

`TAC_DOCKER_SNAPSHOT_MODE=images` removes containers, networks, and Docker
volumes before snapshotting. `TAC_DOCKER_SNAPSHOT_MODE=services` removes
containers/networks but preserves Docker volumes, which is useful for measuring
service-slice startup behavior. Workers should still be treated as fresh TAC
service hosts, not reusable mutable checkpoints.

## Result Storage

Use an external S3 prefix for durable logs and reports:

```bash
TAC_POOL_RESULTS_S3_URI=s3://my-eval-bucket/opentasks/tac \
TAC_POOL_RESUME_FROM_S3=1 \
TAC_POOL_RUN_ID=tac-full-2026-06-20 \
evals/tac/scripts/run-ec2-pool.sh
```

The runner syncs to `TAC_POOL_RESULTS_S3_URI/<run-id>` after completed cells and
after summary generation. The Terraform module can create a disposable bucket
with `TAC_POOL_CREATE_RESULTS_BUCKET=1`, but that bucket belongs to the same
Terraform lifecycle and is removed during default cleanup.

## Manual Provision

```bash
cd infra/tac-ec2-pool
terraform init
terraform apply \
  -var 'name=opentasks-tac-pool' \
  -var 'run_id=tac-manual' \
  -var 'worker_count=4' \
  -var 'instance_type=m7i.2xlarge' \
  -var 'ami_id=ami-optional' \
  -var 'bootstrap_tac=false' \
  -var 'root_volume_gb=80' \
  -var 'tac_service_slice=gitlab' \
  -var 'docker_volume_enabled=true' \
  -var 'docker_volume_snapshot_id=snap-optional' \
  -var 'docker_volume_gb=200' \
  -var 'docker_volume_iops=16000' \
  -var 'docker_volume_throughput=1000' \
  -var 'public_key_path=/Users/alexngai/.ssh/opentasks-tac-pool.pub' \
  -var 'allowed_cidr_blocks=["<your-ip>/32"]' \
  -var 'delete_after=2026-06-20'
```

Write a runner manifest:

```bash
terraform output -json runner_manifest > /tmp/tac-pool-manifest.json
```

Watch bootstrap:

```bash
ssh -i <private-key-path> ubuntu@<worker-ip> \
  'cloud-init status --long; sudo tail -f /var/log/opentasks-tac-worker-bootstrap.log'
```

## Sync OpenTasks

The OpenTasks arm mounts a built runtime from the EC2 host into each TAC task
container. Sync it to every worker before a run:

```bash
for ip in $(jq -r '.workers[].public_ip' /tmp/tac-pool-manifest.json); do
  evals/tac/scripts/sync-opentasks-ec2.sh "$ip" /Users/alexngai/.ssh/opentasks-tac-pool
done
```

## Run A Pooled Eval

```bash
TAC_POOL_MANIFEST=/tmp/tac-pool-manifest.json \
EC2_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2 \
EVAL_MODEL=haiku EVAL_ARMS=stock,notes,opentasks \
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=12 \
npm run eval:tac:pool
```

The pool runner:

- loads TAC task ids with the same selectors as `evals/tac/run.ts`
- expands tasks into `task x arm x model x seed` cells
- leases one cell at a time to each worker
- skips completed success/failure cells on resume
- retries env-error cells up to `TAC_POOL_CELL_MAX_ATTEMPTS`
- quarantines workers after repeated env errors
- sets `EVAL_CONCURRENCY=1` by default
- writes per-cell reports under `evals/.tac-pool-runs/<run-id>/cells/*`
- writes a combined `summary.md` and `summary.json`

## Cleanup

Manual Terraform cleanup:

```bash
terraform destroy \
  -var 'name=opentasks-tac-pool' \
  -var 'worker_count=4' \
  -var 'instance_type=m7i.2xlarge' \
  -var 'public_key_path=/Users/alexngai/.ssh/opentasks-tac-pool.pub' \
  -var 'allowed_cidr_blocks=["<your-ip>/32"]' \
  -var 'delete_after=2026-06-20'
```
