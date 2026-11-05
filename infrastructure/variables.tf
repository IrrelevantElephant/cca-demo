variable "project_name" {
  type    = string
  default = "cca-demo"
}

variable "project_id" {
  type    = string
  default = "906f9aec-92b5-4615-9a54-84d399de5231"
}

variable "region" {
  type    = string
  default = "fr-par"
}

# Docker images

variable "image_api" {
  type = string
}

variable "image_migrations" {
  type = string
}
