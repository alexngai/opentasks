output "instance_id" {
  value = aws_instance.tac.id
}

output "public_ip" {
  value = aws_instance.tac.public_ip
}

output "public_dns" {
  value = aws_instance.tac.public_dns
}

output "ssh_command" {
  value = "ssh -i <private-key-path> ubuntu@${aws_instance.tac.public_ip}"
}

output "tac_service_urls" {
  value = {
    api_server = "http://${aws_instance.tac.public_ip}:2999"
    gitlab     = "http://${aws_instance.tac.public_ip}:8929"
    owncloud   = "http://${aws_instance.tac.public_ip}:8092"
    plane      = "http://${aws_instance.tac.public_ip}:8091"
    rocketchat = "http://${aws_instance.tac.public_ip}:3000"
  }
}
