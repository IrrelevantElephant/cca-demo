resource "scaleway_iam_application" "app" {
  name = "${local.project_name}-app"
}

resource "scaleway_iam_policy" "db_access" {
  name           = "${local.project_name}-db-access"
  application_id = scaleway_iam_application.app.id
  rule {
    project_ids          = [var.project_id]
    permission_set_names = ["ServerlessSQLDatabaseReadWrite"]
  }
}

resource "scaleway_iam_api_key" "api_key" {
  application_id = scaleway_iam_application.app.id
}

resource "random_id" "db_suffix" {
  byte_length = 4
}

resource "scaleway_sdb_sql_database" "cca-demo_database" {
  name    = "${local.project_name}-database-${random_id.db_suffix.hex}"
  min_cpu = 0
  max_cpu = 8
}

resource "scaleway_secret" "connection_string" {
  name = "${local.project_name}-connection-string"
}

resource "scaleway_secret_version" "connection_string" {
  secret_id = scaleway_secret.connection_string.id
  data = format("postgres://%s:%s@%s",
    scaleway_iam_application.app.id,
    scaleway_iam_api_key.api_key.secret_key,
    trimprefix(scaleway_sdb_sql_database.cca-demo_database.endpoint, "postgres://"),
  )
}

data "scaleway_secret_version" "connection_string" {
  secret_id  = scaleway_secret.connection_string.id
  revision   = "latest"
  depends_on = [scaleway_secret_version.connection_string]
}
