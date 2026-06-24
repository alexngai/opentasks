variable "region" {
  description = "AWS region for the TAC worker pool."
  type        = string
  default     = "us-west-1"
}

variable "name" {
  description = "Name prefix for pool resources."
  type        = string
  default     = "opentasks-tac-pool"
}

variable "worker_count" {
  description = "Number of TAC worker nodes. Each worker should run at most one active TAC cell."
  type        = number
  default     = 2

  validation {
    condition     = var.worker_count >= 1
    error_message = "worker_count must be at least 1."
  }
}

variable "instance_type" {
  description = "EC2 instance type for each TAC worker."
  type        = string
  default     = "m7i.2xlarge"
}

variable "ami_id" {
  description = "Optional pre-baked TAC worker AMI. Defaults to the latest Ubuntu Noble AMI."
  type        = string
  default     = ""
}

variable "bootstrap_tac" {
  description = "Run TAC worker bootstrap user-data. Set false when ami_id already contains Docker, TAC servers, and Node."
  type        = bool
  default     = true
}

variable "root_volume_gb" {
  description = "Root gp3 EBS volume size in GiB for each worker."
  type        = number
  default     = 200
}

variable "docker_volume_enabled" {
  description = "Attach a separate EBS volume for Docker and containerd data."
  type        = bool
  default     = false
}

variable "docker_volume_gb" {
  description = "Docker data gp3 EBS volume size in GiB when docker_volume_enabled is true."
  type        = number
  default     = 200
}

variable "docker_volume_iops" {
  description = "Provisioned gp3 IOPS for the Docker data volume."
  type        = number
  default     = 3000

  validation {
    condition     = var.docker_volume_iops >= 3000 && var.docker_volume_iops <= 16000
    error_message = "docker_volume_iops must be between 3000 and 16000 for gp3."
  }
}

variable "docker_volume_throughput" {
  description = "Provisioned gp3 throughput in MiB/s for the Docker data volume."
  type        = number
  default     = 125

  validation {
    condition     = var.docker_volume_throughput >= 125 && var.docker_volume_throughput <= 1000
    error_message = "docker_volume_throughput must be between 125 and 1000 MiB/s for gp3."
  }
}

variable "docker_volume_snapshot_id" {
  description = "Optional EBS snapshot id used to seed the Docker data volume."
  type        = string
  default     = ""
}

variable "docker_volume_device_name" {
  description = "Linux block device name requested for the Docker data volume."
  type        = string
  default     = "/dev/sdf"
}

variable "docker_volume_mount_point" {
  description = "Mount point for the Docker/containerd data volume."
  type        = string
  default     = "/mnt/tac-docker"
}

variable "tac_version" {
  description = "TAC Docker image tag to pre-pull during bootstrap."
  type        = string
  default     = "1.0.0"
}

variable "tac_service_slice" {
  description = "TAC service slice to start during bootstrap. Use gitlab for GitLab-only SDE tasks; full starts the standard TAC stack."
  type        = string
  default     = "full"

  validation {
    condition     = contains(["full", "gitlab"], var.tac_service_slice)
    error_message = "tac_service_slice must be one of: full, gitlab."
  }
}

variable "subnet_id" {
  description = "Optional subnet id. Defaults to spreading across default public subnets."
  type        = string
  default     = ""
}

variable "key_name" {
  description = "Existing EC2 key pair name. Leave empty to create one from public_key_path."
  type        = string
  default     = ""

  validation {
    condition     = var.key_name != "" || var.public_key_path != ""
    error_message = "Set either key_name or public_key_path."
  }
}

variable "public_key_path" {
  description = "Public SSH key path used only when key_name is empty."
  type        = string
  default     = ""
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach SSH and TAC service ports."
  type        = list(string)
}

variable "allowed_ports" {
  description = "TCP ports exposed to allowed_cidr_blocks."
  type        = list(number)
  default     = [22, 2999, 8929, 2424, 8092, 8091, 3000]
}

variable "delete_after" {
  description = "Tag value documenting when this pool should be removed."
  type        = string
}

variable "run_id" {
  description = "Eval run id used for resource tags and provenance."
  type        = string
  default     = ""
}

variable "create_results_bucket" {
  description = "Create an encrypted, disposable S3 bucket for future pooled result uploads."
  type        = bool
  default     = false
}

variable "results_retention_days" {
  description = "Lifecycle expiration in days when create_results_bucket is true."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Extra tags applied to all pool resources."
  type        = map(string)
  default     = {}
}
