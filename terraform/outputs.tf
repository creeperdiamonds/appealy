# ---------------------------------------------------------------------------
# Everything you need to paste elsewhere after `apply`.
# ---------------------------------------------------------------------------

output "github_variables" {
  description = "Repository VARIABLES (Settings → Secrets and variables → Actions → Variables)"
  value = {
    GCP_PROJECT_ID    = var.project_id
    GCP_REGION        = var.region
    ARTIFACT_REGISTRY = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.appealy.repository_id}"
  }
}

output "github_secrets" {
  description = "Repository SECRETS (same page, Secrets tab)"
  value = {
    GCP_WORKLOAD_IDENTITY_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_SERVICE_ACCOUNT            = google_service_account.deploy.email
  }
}

output "runtime_service_account" {
  description = "Pass to Cloud Run as --service-account. The containers run as this."
  value       = google_service_account.runtime.email
}

output "cloudsql_connection_name" {
  description = "For --add-cloudsql-instances and the socket path in DATABASE_URL"
  value       = google_sql_database_instance.appealy.connection_name
}

# Marked sensitive so it isn't printed by a bare `terraform output`. Read it
# deliberately with `terraform output -raw database_url`.
output "database_url" {
  description = "Connection string for the appealy-database-url secret"
  sensitive   = true
  value       = "postgresql://appealy:${random_password.db.result}@localhost/appealy?host=/cloudsql/${google_sql_database_instance.appealy.connection_name}"
}

output "redis_url" {
  description = "Empty when enable_redis is false"
  value       = var.enable_redis ? "redis://${google_redis_instance.appealy[0].host}:${google_redis_instance.appealy[0].port}" : ""
}

output "vpc_connector" {
  description = "Pass to Cloud Run as --vpc-connector when Redis is enabled"
  value       = var.enable_redis ? google_vpc_access_connector.appealy[0].name : ""
}

output "secret_commands" {
  description = "Run these to populate Secret Manager. Values never touch Terraform state."
  value       = <<-EOT

    # Generated values — the database URL comes from Terraform:
    terraform output -raw database_url | gcloud secrets versions add appealy-database-url --data-file=-

    # Generate these two now, and back up the encryption key somewhere off-server.
    # Losing it makes every stored Discord token unreadable and forces all users
    # to re-authorize.
    openssl rand -hex 48 | tr -d '\n' | gcloud secrets versions add appealy-session-secret --data-file=-
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add appealy-token-encryption-key --data-file=-

    # From the Discord Developer Portal. The -n on echo matters: without it you
    # store a trailing newline, and a bot token with \n on the end fails auth
    # with an error that never mentions whitespace.
    echo -n "TOKEN"      | gcloud secrets versions add appealy-discord-bot-token --data-file=-
    echo -n "APP_ID"     | gcloud secrets versions add appealy-discord-application-id --data-file=-
    echo -n "PUBLIC_KEY" | gcloud secrets versions add appealy-discord-public-key --data-file=-
    echo -n "CLIENT_ID"  | gcloud secrets versions add appealy-discord-client-id --data-file=-
    echo -n "SECRET"     | gcloud secrets versions add appealy-discord-client-secret --data-file=-
    echo -n "YOUR_USER_ID" | gcloud secrets versions add appealy-ops-user-ids --data-file=-

    # Only if enable_redis = true:
    # terraform output -raw redis_url | gcloud secrets versions add appealy-redis-url --data-file=-
  EOT
}

output "estimated_monthly_cost" {
  description = "Rough, us-central1, before egress"
  value = join("\n", compact([
    "Cloud SQL (${var.db_tier}, zonal, 10GB SSD):  ~$10-15",
    var.enable_redis ? "Memorystore (${var.redis_memory_gb}GB BASIC):            ~$26" : "Memorystore:                             disabled",
    var.enable_redis ? "VPC connector (2 instances, always on):   ~$9" : "VPC connector:                           disabled",
    "Artifact Registry (a few GB):             ~$1",
    "Secret Manager:                           <$1",
    "Cloud Run (api+web, low traffic):         ~$0-5",
    "",
    var.enable_redis ? "TOTAL: roughly $50-60/month" : "TOTAL: roughly $15-25/month",
    "",
    "Cloud Run for the BOT is not included and is not recommended — see",
    "DOCKER.md. A gateway connection needs --min-instances=1 and",
    "--no-cpu-throttling, which bills CPU continuously for about the price of",
    "an e2-micro VM, with more moving parts.",
  ]))
}
