# ---------------------------------------------------------------------------
# Cloud SQL — Postgres
#
# The single largest line on the bill. db-f1-micro is deliberate: the app's
# own connection pool is capped at 10 per process (two processes, so 20), and
# SCALING.md identifies that pool as the actual bottleneck. A larger instance
# doesn't help until that number changes.
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "appealy" {
  name             = "appealy-db"
  database_version = "POSTGRES_16"
  region           = var.region

  # Blocks accidental deletion via terraform destroy. There is a second,
  # provider-level guard below; both have to be turned off to lose the data,
  # which is the point.
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # REGIONAL doubles the cost for failover you don't need yet
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      # Seven days of PITR. The cost is small and it's the difference between
      # "we lost an hour" and "we lost everything" after a bad migration.
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
      }
    }

    ip_configuration {
      # No public IP. Cloud Run reaches this over the Cloud SQL socket, which
      # doesn't need one — a public IP here is an internet-facing Postgres
      # protected only by a password.
      ipv4_enabled = false
      private_network = google_compute_network.appealy.id
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 4
    }

    database_flags {
      # Matches what the app actually opens. The default of 100 reserves
      # memory per slot on an instance that has little to spare.
      name  = "max_connections"
      value = "50"
    }
  }

  depends_on = [
    google_project_service.required,
    google_service_networking_connection.private_vpc,
  ]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_sql_database" "appealy" {
  name     = "appealy"
  instance = google_sql_database_instance.appealy.name
}

resource "google_sql_user" "appealy" {
  name     = "appealy"
  instance = google_sql_database_instance.appealy.name
  password = random_password.db.result
}

# Generated rather than supplied, so it never exists in a .tfvars file. It
# does land in terraform.tfstate — see the note in outputs.tf about why that
# file needs protecting regardless.
resource "random_password" "db" {
  length  = 32
  special = false # avoids URL-encoding problems in the connection string
}

# ---------------------------------------------------------------------------
# Private networking
#
# Required for a Cloud SQL instance without a public IP, and reused by
# Memorystore if Redis is enabled.
# ---------------------------------------------------------------------------

resource "google_compute_network" "appealy" {
  name                    = "appealy-network"
  auto_create_subnetworks = true
  depends_on              = [google_project_service.required]
}

resource "google_compute_global_address" "private_ip" {
  name          = "appealy-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.appealy.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.appealy.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}
