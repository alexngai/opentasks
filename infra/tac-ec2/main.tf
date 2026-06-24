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

data "aws_caller_identity" "current" {}

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

resource "aws_security_group" "tac" {
  name        = var.name
  description = "OpenTasks TAC EC2 spike"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = toset(var.allowed_ports)
    content {
      description = "TAC spike port ${ingress.value}"
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

resource "aws_instance" "tac" {
  ami                         = data.aws_ami.ubuntu_noble.id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default_public.ids[0]
  vpc_security_group_ids      = [aws_security_group.tac.id]
  key_name                    = local.effective_key_name
  associate_public_ip_address = true
  user_data                   = file("${path.module}/user-data.sh")

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${var.name}-root" })
  }

  tags = merge(local.tags, { Name = var.name })
}

locals {
  effective_key_name = var.key_name != "" ? var.key_name : aws_key_pair.generated[0].key_name
  tags = {
    Project     = "opentasks"
    Purpose     = "tac-ec2-spike"
    ManagedBy   = "terraform"
    DeleteAfter = var.delete_after
  }
}
