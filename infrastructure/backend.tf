terraform {
  backend "s3" {
    bucket                      = "cca-demo-tfstate"
    key                         = "cca-demo.tfstate"
    region                      = "fr-par"
    endpoint                    = "https://s3.fr-par.scw.cloud"
    skip_credentials_validation = true
    force_path_style            = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
