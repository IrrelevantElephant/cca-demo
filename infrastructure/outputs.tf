output "api_hostname" {
  value = scaleway_container_domain.api.hostname
}

output "container_registry" {
  value = scaleway_registry_namespace.container_registry.endpoint
}

output "migration_job_id" {
  value = scaleway_job_definition.migrations.id
}

output "region" {
  value = var.region
}

output "organization_id" {
  value = local.organization_id
}

output "project_id" {
  value = var.project_id
}
