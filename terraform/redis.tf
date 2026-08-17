# ---------------------------------------------------------------------------
# Memorystore — optional
#
# Two costs, and the second one surprises people: the instance itself (~$26/mo
# for the 1GB minimum) and the Serverless VPC Access connector Cloud Run needs
# to reach it (~$9/mo, billed whether or not traffic flows).
#
# Everything Redis holds in this app is reconstructible. With enable_redis =
# false the app runs with caches falling back to TTL and rate-limit counters
# resetting on restart — degraded, not broken. That's the right trade while
# proving the product out.
# ---------------------------------------------------------------------------

resource "google_redis_instance" "appealy" {
  count = var.enable_redis ? 1 : 0

  name           = "appealy-redis"
  tier           = "BASIC" # STANDARD_HA doubles cost for replication this doesn't need
  memory_size_gb = var.redis_memory_gb
  region         = var.region

  authorized_network = google_compute_network.appealy.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  redis_version      = "REDIS_7_0"

  depends_on = [
    google_project_service.required,
    google_service_networking_connection.private_vpc,
  ]
}

# Cloud Run cannot reach anything on a VPC without this. It is the reason
# Redis costs more than the Redis instance.
resource "google_vpc_access_connector" "appealy" {
  count = var.enable_redis ? 1 : 0

  name          = "appealy-connector"
  region        = var.region
  network       = google_compute_network.appealy.name
  ip_cidr_range = "10.8.0.0/28"

  # Smallest allowed. Throughput scales with instance count; this workload
  # sends very little over the connector.
  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.required]
}
