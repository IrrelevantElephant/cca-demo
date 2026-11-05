resource "scaleway_job_definition" "migrations" {
  name                   = "${local.project_name}-migrations"
  image_uri              = var.image_migrations
  cpu_limit              = 1000
  memory_limit           = 512
  local_storage_capacity = 1000
  timeout                = "600s"

  secret_reference {
    secret_id      = scaleway_secret.connection_string.id
    secret_version = data.scaleway_secret_version.connection_string.revision
    environment    = "ConnectionString"
  }

  depends_on = [scaleway_iam_policy.db_access]
}
