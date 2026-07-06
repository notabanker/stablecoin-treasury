terraform {
  required_version = ">= 1.5"

  # Backend configuration is intentional placeholder — no state exists.
  # backend "s3" {
  #   bucket = "treasury-terraform-state"
  #   key    = "prod/terraform.tfstate"
  #   region = "eu-west-1"
  # }
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "region" {
  description = "Cloud region"
  type        = string
  default     = "eu-west-1"
}

variable "database_password" {
  description = "Managed Postgres password (from secrets manager)"
  type        = string
  sensitive   = true
}

variable "service_db_password" {
  description = "Per-service role password (from secrets manager)"
  type        = string
  sensitive   = true
}

variable "internal_service_token" {
  description = "Internal HMAC shared secret (from secrets manager)"
  type        = string
  sensitive   = true
}

variable "webhook_secret" {
  description = "Global webhook signing secret (from secrets manager)"
  type        = string
  sensitive   = true
}

module "network" {
  source = "./modules/network"
  environment = var.environment
  region      = var.region
}

module "postgres" {
  source = "./modules/postgres"
  environment       = var.environment
  region            = var.region
  vpc_id            = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  database_password  = var.database_password
}

module "secrets" {
  source = "./modules/secrets"
  environment = var.environment
  region      = var.region
  service_db_password     = var.service_db_password
  internal_service_token  = var.internal_service_token
  webhook_secret          = var.webhook_secret
}

module "ingress" {
  source = "./modules/ingress"
  environment = var.environment
  region      = var.region
  vpc_id      = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
}

output "database_endpoint" {
  value     = module.postgres.endpoint
  sensitive = true
}
