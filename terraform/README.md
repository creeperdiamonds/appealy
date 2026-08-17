# Terraform

Defines the GCP infrastructure Appealy needs, so it can be created, reviewed,
and destroyed as one unit instead of clicked through the console.

## Read this before applying

**This costs money the moment it works.** Roughly $45–75/month for the default
config — Cloud SQL is the bulk of it, and the VPC connector Redis requires is
another ~$9 whether or not anything uses it.

**You do not need this for a proof of concept.** `./setup.sh` on any machine
gives you a working system in twenty minutes with Docker Compose. Terraform is
worth writing once you know what you need, and right now nothing has been
deployed, so nobody does. Prove the product works first, then codify the
infrastructure that turned out to be necessary.

Two ways to spend less while proving it out:

- **Skip Redis entirely at first.** It's used for rate-limit counters, cache
  invalidation and pending form answers — all reconstructible. Setting
  `enable_redis = false` drops the VPC connector too, saving ~$35/month
  combined. The app degrades rather than breaks.
- **`db_tier = "db-f1-micro"`** is the default here for the same reason. Fine
  for a few hundred guilds.

## Layout

```
main.tf         providers, APIs, project-level bits
database.tf     Cloud SQL Postgres
redis.tf        Memorystore + the VPC connector it needs
secrets.tf      Secret Manager entries and IAM
iam.tf          service accounts, Workload Identity Federation
variables.tf    everything you're expected to set
outputs.tf      values you'll need for GitHub secrets and .env
```

## Usage

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill this in
terraform init
terraform plan      # read this before applying — it lists what will be billed
terraform apply
```

`terraform destroy` removes everything. Worth knowing you can do that; it's the
main reason to define infrastructure this way rather than by hand.

## State

State is local by default, which is fine for one person and a problem for two —
if you and your father both apply from different machines you'll get conflicts
and possibly duplicate resources. Once you're both working on it, uncomment the
GCS backend in `main.tf` and run `terraform init -migrate-state`.
