resource "scaleway_registry_namespace" "container_registry" {
  name        = "cr-${local.project_name}"
  description = "Container registry for ${local.project_name} project"
  is_public   = false
}
