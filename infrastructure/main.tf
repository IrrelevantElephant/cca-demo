terraform {
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.75.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.6.0"
    }
  }
}

provider "scaleway" {
  organization_id = local.organization_id
  project_id      = var.project_id
  region          = var.region
  zone            = "${var.region}-1"
}
