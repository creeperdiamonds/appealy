terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in GCS, configured at init time rather than hardcoded here so
  # the bucket name can carry the project id (bucket names are global).
  #
  # It is not local any more, and that is the point: a state file on one
  # machine is one disk failure away from resources nothing can manage, and it
  # holds the generated database password in plaintext. The CI workflow
  # (.github/workflows/terraform.yml) creates the bucket if missing, versioned.
  #
  # Running terraform locally now needs the same backend config:
  #
  #   terraform init   #     -backend-config="bucket=<project-id>-appealy-tfstate"   #     -backend-config="prefix=prod"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# APIs
#
# Every one of these has to be enabled before the resources below can be
# created, and the error when one isn't is a permission denial that doesn't
# mention the API. Enabling them here is what makes a fresh project work from
# a single `apply`.
# ---------------------------------------------------------------------------

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "vpcaccess.googleapis.com",
    "compute.googleapis.com",
  ])

  service = each.value

  # Leave the APIs enabled on destroy. Disabling them can break other things
  # in the project, and they cost nothing when unused.
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Artifact Registry — where the workflow pushes images
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "appealy" {
  location      = var.region
  repository_id = "appealy-repo"
  format        = "DOCKER"
  description   = "Container images for Appealy"

  depends_on = [google_project_service.required]
}
