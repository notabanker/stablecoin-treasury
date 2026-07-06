# Infrastructure — Terraform Skeleton (V6 Task 7.1)

**Nothing here is provisioned.** This directory contains Terraform plan artifacts
(modules and variables) that describe the target infrastructure shape. No state
exists, no credentials are present, no cloud resources have been created.

Actual provisioning is a human-executed milestone tracked in Task 7.2
(`docs/PRODUCTION_READINESS.md` § External Infrastructure).

## Modules

| Module | Purpose |
|---|---|
| `network` | Private subnets, gateway-only ingress, service-to-service routing |
| `postgres` | Managed Postgres with PITR enabled, backup retention |
| `secrets` | Secrets-manager references (no values) |
| `ingress` | WAF-fronted load balancer, TLS termination |

## Usage (when provisioning)

```bash
cd infra/
cp terraform.tfvars.example terraform.tfvars  # fill in real values
terraform init
terraform plan
terraform apply
```

## Required Decisions (before provisioning)

- Secrets manager: AWS Secrets Manager, HashiCorp Vault, or cloud-native
- IaC tool: Terraform confirmed (this skeleton)
- Runtime target: AWS ECS, GCP Cloud Run, or Kubernetes
- DNS and TLS certificate provisioning
- Monitoring stack: CloudWatch, Grafana, or Datadog
