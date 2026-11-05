resource "scaleway_container_namespace" "main" {
  name = "${local.project_name}-api"
}

resource "scaleway_container" "api" {
  name         = "${local.project_name}-api"
  namespace_id = scaleway_container_namespace.main.id
  image        = var.image_api
  port         = 8080

  cpu_limit          = 128
  memory_limit_bytes = 512000000
  min_scale          = 0
  max_scale          = 1
  timeout            = 600
  protocol           = "http1"

  environment_variables = {
    "DEMO_INCIDENT_ENABLED" = "true"
  }

  secret_environment_variables = {
    "ConnectionString" = base64decode(data.scaleway_secret_version.connection_string.data)
  }
}

resource "scaleway_container_domain" "api" {
  container_id = scaleway_container.api.id
  hostname     = "cca-demo.irrelevantelephant.co.uk"
}
