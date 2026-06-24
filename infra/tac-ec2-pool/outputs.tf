output "workers" {
  value = [
    for i, instance in aws_instance.worker : {
      id               = instance.id
      name             = "${var.name}-${i}"
      public_ip        = instance.public_ip
      public_dns       = instance.public_dns
      ssh_user         = "ubuntu"
      worker_index     = i
      docker_volume_id = local.worker_docker_volume_ids[i]
    }
  ]
}

output "runner_manifest" {
  value = {
    ami_id                    = local.worker_ami_id
    bootstrap_tac             = var.bootstrap_tac
    docker_volume_enabled     = var.docker_volume_enabled
    docker_volume_snapshot_id = var.docker_volume_snapshot_id != "" ? var.docker_volume_snapshot_id : null
    docker_volume_mount_point = var.docker_volume_mount_point
    tac_service_slice         = var.tac_service_slice
    key_pair_name             = local.effective_key_name
    generated_key             = var.key_name == ""
    region                    = var.region
    results_bucket            = var.create_results_bucket ? aws_s3_bucket.results[0].bucket : null
    security_group_id         = aws_security_group.worker.id
    workers = [
      for i, instance in aws_instance.worker : {
        id               = instance.id
        name             = "${var.name}-${i}"
        public_ip        = instance.public_ip
        public_dns       = instance.public_dns
        ssh_user         = "ubuntu"
        worker_index     = i
        docker_volume_id = local.worker_docker_volume_ids[i]
      }
    ]
  }
}

output "ssh_commands" {
  value = [
    for instance in aws_instance.worker : "ssh -i <private-key-path> ubuntu@${instance.public_ip}"
  ]
}

output "security_group_id" {
  value = aws_security_group.worker.id
}

output "results_bucket" {
  value = var.create_results_bucket ? aws_s3_bucket.results[0].bucket : null
}

output "ami_id" {
  value = local.worker_ami_id
}

output "key_pair_name" {
  value = local.effective_key_name
}
