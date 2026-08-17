variable "project_id" {
  description = "GCP project ID (not the display name — the one with the number suffix)"
  type        = string
}

variable "region" {
  description = "Region for all regional resources. Keep everything in one region; cross-region traffic is billed and slower."
  type        = string
  default     = "us-central1"
}

variable "github_repo" {
  description = "owner/repo, used to scope Workload Identity Federation. Must match exactly or GitHub authenticates and GCP rejects it."
  type        = string
  default     = "creeperdiamonds/appealy"

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "Must be in the form owner/repo."
  }
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "db_tier" {
  description = <<-EOT
    Cloud SQL machine type. db-f1-micro is ~$8/month and enough for a few
    hundred guilds — the app's own pool is capped at 10 connections per
    process, so a bigger instance buys nothing until that changes.
  EOT
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Blocks `terraform destroy` from deleting the database. Leave true once real data exists."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Redis — optional, and expensive relative to what it does here
# ---------------------------------------------------------------------------

variable "enable_redis" {
  description = <<-EOT
    Memorystore plus the VPC connector Cloud Run needs to reach it: roughly
    $35/month combined, and the connector bills whether traffic flows or not.

    Everything Redis holds here is reconstructible — rate-limit counters, cache
    invalidation, pending form answers. With it off the app degrades (caches
    fall back to TTL, rate limits reset on restart) rather than breaking.

    Off by default so a first `apply` doesn't quietly commit you to it.
  EOT
  type        = bool
  default     = false
}

variable "redis_memory_gb" {
  description = "Smallest is 1GB. The workload here uses a fraction of that."
  type        = number
  default     = 1
}

# ---------------------------------------------------------------------------
# Application secrets
#
# Declared here so Terraform creates the Secret Manager entries and the IAM
# binding, but NOT their values — a secret value in a .tfvars file ends up in
# terraform.tfstate in plaintext, which is then a file you have to protect as
# carefully as the secret itself. Add versions with gcloud instead; see
# outputs.tf for the exact commands.
# ---------------------------------------------------------------------------

variable "app_secrets" {
  description = "Secret Manager entries to create. Values are added out of band."
  type        = list(string)
  default = [
    "appealy-database-url",
    "appealy-redis-url",
    "appealy-discord-bot-token",
    "appealy-discord-application-id",
    "appealy-discord-public-key",
    "appealy-discord-client-id",
    "appealy-discord-client-secret",
    "appealy-session-secret",
    "appealy-token-encryption-key",
    "appealy-ops-user-ids",
  ]
}
