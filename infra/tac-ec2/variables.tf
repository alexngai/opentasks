variable "region" {
  description = "AWS region for the TAC service host."
  type        = string
  default     = "us-west-1"
}

variable "name" {
  description = "Name prefix for EC2 resources."
  type        = string
  default     = "opentasks-tac-spike"
}

variable "instance_type" {
  description = "EC2 instance type for the TAC services host."
  type        = string
  default     = "t3.2xlarge"
}

variable "root_volume_gb" {
  description = "Root gp3 EBS volume size in GiB."
  type        = number
  default     = 200
}

variable "subnet_id" {
  description = "Optional subnet id. Defaults to the first default public subnet in the default VPC."
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
  description = "Tag value documenting when this spike host should be removed."
  type        = string
  default     = "2026-06-19"
}
