terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_ami" "ubuntu_noble" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "generated" {
  count      = var.key_name == "" ? 1 : 0
  key_name   = "${var.name}-key"
  public_key = file(var.public_key_path)

  tags = local.tags
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "OpenTasks TAC EC2 worker pool"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = toset(var.allowed_ports)
    content {
      description = "TAC worker port ${ingress.value}"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.allowed_cidr_blocks
    }
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_instance" "worker" {
  count                       = var.worker_count
  ami                         = local.worker_ami_id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default_public.ids[count.index % length(data.aws_subnets.default_public.ids)]
  vpc_security_group_ids      = [aws_security_group.worker.id]
  key_name                    = local.effective_key_name
  associate_public_ip_address = true
  user_data = local.needs_user_data ? templatefile("${path.module}/user-data.sh", {
    bootstrap_tac             = var.bootstrap_tac
    docker_volume_enabled     = var.docker_volume_enabled
    docker_volume_device_name = var.docker_volume_device_name
    docker_volume_mount_point = var.docker_volume_mount_point
    tac_version               = var.tac_version
    tac_service_slice         = var.tac_service_slice
  }) : null

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${var.name}-${count.index}-root" })
  }

  dynamic "ebs_block_device" {
    for_each = var.docker_volume_enabled ? [1] : []
    content {
      device_name           = var.docker_volume_device_name
      snapshot_id           = var.docker_volume_snapshot_id != "" ? var.docker_volume_snapshot_id : null
      volume_size           = var.docker_volume_gb
      volume_type           = "gp3"
      iops                  = var.docker_volume_iops
      throughput            = var.docker_volume_throughput
      delete_on_termination = true
      tags                  = merge(local.tags, { Name = "${var.name}-${count.index}-docker" })
    }
  }

  tags = merge(local.tags, {
    Name        = "${var.name}-${count.index}"
    WorkerIndex = tostring(count.index)
  })
}

resource "aws_s3_bucket" "results" {
  count         = var.create_results_bucket ? 1 : 0
  bucket_prefix = "${var.name}-results-"
  force_destroy = true

  tags = local.tags
}

resource "aws_s3_bucket_server_side_encryption_configuration" "results" {
  count  = var.create_results_bucket ? 1 : 0
  bucket = aws_s3_bucket.results[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "results" {
  count  = var.create_results_bucket ? 1 : 0
  bucket = aws_s3_bucket.results[0].id

  rule {
    id     = "expire-tac-results"
    status = "Enabled"

    filter {}

    expiration {
      days = var.results_retention_days
    }
  }
}

locals {
  effective_key_name = var.key_name != "" ? var.key_name : aws_key_pair.generated[0].key_name
  worker_ami_id      = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu_noble.id
  needs_user_data    = var.bootstrap_tac || var.docker_volume_enabled
  worker_docker_volume_ids = [
    for instance in aws_instance.worker :
    var.docker_volume_enabled ? try([
      for block in instance.ebs_block_device : block.volume_id
      if block.device_name == var.docker_volume_device_name
    ][0], null) : null
  ]
  tags = merge(
    {
      Project     = "opentasks"
      Purpose     = "tac-ec2-pool"
      ManagedBy   = "terraform"
      DeleteAfter = var.delete_after
      RunId       = var.run_id
    },
    var.tags,
  )
}
