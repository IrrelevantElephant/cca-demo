resource "scaleway_object_bucket" "terraform-state" {
  name       = "${local.project_name}-tfstate"
  region     = "fr-par"
  project_id = var.project_id
}
