# ---------------------------------------------------------------------------
# Secret Manager
#
# Terraform creates the containers; it does NOT set the values.
#
# That's deliberate. A secret value passed as a Terraform variable is written
# to terraform.tfstate in plaintext, so the state file becomes as sensitive as
# the bot token itself — and state files get committed, copied between
# machines, and shared far more casually than secrets do. Adding versions with
# gcloud keeps them out of state entirely.
#
# See `terraform output secret_commands` for the exact commands to run.
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "app" {
  for_each = toset(var.app_secrets)

  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

# The runtime account already has project-level secretAccessor in iam.tf. This
# is a per-secret binding as well, so that if the project-level role is ever
# narrowed the app keeps working — and so it's visible at the secret which
# identity reads it.
resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each = google_secret_manager_secret.app

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
