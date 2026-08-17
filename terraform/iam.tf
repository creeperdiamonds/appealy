# ---------------------------------------------------------------------------
# Service accounts
#
# Two, deliberately separate:
#
#   deploy   used by GitHub Actions. Can push images and deploy revisions.
#   runtime  what the containers run as. Can read secrets and reach the DB.
#
# Splitting them means a compromised CI token can't read your bot token, and
# a compromised container can't deploy new revisions. Using one account for
# both is the common shortcut and it collapses that distinction.
# ---------------------------------------------------------------------------

resource "google_service_account" "deploy" {
  account_id   = "appealy-deploy"
  display_name = "Appealy — GitHub Actions deployer"
}

resource "google_service_account" "runtime" {
  account_id   = "appealy-runtime"
  display_name = "Appealy — Cloud Run runtime"
}

resource "google_project_iam_member" "deploy" {
  for_each = toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    # Required to deploy a service that runs AS the runtime account. Without
    # it the deploy fails with a message about impersonation that doesn't
    # obviously point here.
    "roles/iam.serviceAccountUser",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------------------
# Workload Identity Federation
#
# Lets GitHub Actions authenticate to GCP without a service account key file.
# That matters: a key file is a long-lived credential that has to live in a
# GitHub secret, and if it leaks it stays valid until someone notices and
# revokes it. WIF issues short-lived tokens against GitHub's own OIDC identity.
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # THE LINE THAT MATTERS.
  #
  # Without this condition, ANY GitHub repository on the internet can
  # authenticate against this pool — including a fork, or a repo someone
  # creates specifically to attack it. Google requires a condition on new
  # providers for exactly this reason.
  attribute_condition = "assertion.repository == '${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Binds the pool to the deploy account, scoped to this one repository.
resource "google_service_account_iam_member" "github_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
