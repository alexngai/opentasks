# TAC EC2 Spike

Terraform module for a disposable TheAgentCompany service host.

It creates:

- one Ubuntu 24.04 EC2 instance
- one security group scoped to your CIDR
- a 200 GiB gp3 root volume
- cloud-init bootstrap that installs Docker and runs TAC's official `servers/setup.sh`
- a bootstrap workaround that aliases `bitnamilegacy/mongodb:5.0` to
  `bitnami/mongodb:5.0`, matching the image name used by TAC's embedded API
  server compose file

Usage:

```bash
cd infra/tac-ec2
terraform init
terraform apply \
  -var 'key_name=opentasks-tac-spike-20260618' \
  -var 'allowed_cidr_blocks=["<your-ip>/32"]'
```

If you do not already have an EC2 key pair, create one from a local SSH public
key instead:

```bash
terraform apply \
  -var 'public_key_path=/Users/alexngai/.ssh/id_rsa.pub' \
  -var 'allowed_cidr_blocks=["<your-ip>/32"]'
```

Bootstrap logs:

```bash
ssh -i <private-key-path> ubuntu@<public-ip> \
  'cloud-init status --long; sudo tail -f /var/log/opentasks-tac-bootstrap.log'
```

For TAC task containers running elsewhere, use the EC2 public DNS or IP as
`TAC_SERVER_HOSTNAME`.

Validated spike result:

- Instance: `t3.2xlarge`, 200 GiB gp3 root volume, Ubuntu 24.04.
- TAC full service bootstrap completed after the MongoDB alias workaround.
- Steady disk usage after all services were up was roughly 54 GiB.
- One OpenTasks TAC smoke run completed against the EC2 service host:
  `TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=1 EVAL_ARMS=stock`.
