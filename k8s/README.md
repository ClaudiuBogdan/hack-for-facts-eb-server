# Kubernetes Deployment Guide

<!-- REVIEW: Updated all project references from "Musclecode" to "Transparenta.eu"

     Justification: The original README was copied from another project and contained
     incorrect references. This caused confusion as the namespaces, service names,
     and documentation did not match the actual deployment manifests.
-->

This directory contains the Kubernetes manifests for deploying the Transparenta.eu Backend Service. The deployment is structured using Kustomize for environment-specific configurations and sealed-secrets for sensitive data.

## Directory Structure

```
k8s/
├── base/                 # Base configurations
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── postgres-deployment.yaml
│   ├── postgres-userdata.yaml
│   ├── redis.yaml
│   ├── virtual-service.yaml
│   └── kustomization.yaml
└── overlays/            # Environment-specific configurations
    ├── dev/
    │   ├── kustomization.yaml
    │   └── secrets/
    │       └── sealed-*.yaml
    └── prod/
        ├── kustomization.yaml
        └── secrets/
            └── sealed-*.yaml
```

## Environment Setup

### Prerequisites

1. Install required tools:
   - kubectl
   - kubeseal
   - kustomize

2. Access to:
   - Kubernetes cluster
   - ArgoCD instance
   - Sealed Secrets controller (for secret management)

### Setting Up a New Environment

1. Create environment-specific secret template:

```bash
# Create a directory for your secrets (do not commit this)
mkdir -p k8s/overlays/<env>/secrets

# Create the secret template
kubectl create secret generic hack-for-facts-eb-server-secrets \
  --namespace=hack-for-facts-<env> \
  --from-literal=DATABASE_URL=postgresql://... \
  --from-literal=REDIS_URL=redis://... \
  --dry-run=client -o yaml > k8s/overlays/<env>/secrets/app-secret.yaml
```

2. Seal the secret:

```bash
# Seal the secret for the specific environment
kubeseal --format yaml \
  --namespace hack-for-facts-<env> \
  < k8s/overlays/<env>/secrets/app-secret.yaml \
  > k8s/overlays/<env>/secrets/sealed-app-secret.yaml
```

3. Commit only the sealed secret:

```bash
git add k8s/overlays/<env>/secrets/sealed-app-secret.yaml
git commit -m "Add sealed secrets for <env> environment"
```

## Deployment Process

### Manual Deployment

To deploy to a specific environment:

```bash
# Preview the manifests
kustomize build k8s/overlays/<env>

# Apply the manifests
kustomize build k8s/overlays/<env> | kubectl apply -f -
```

### ArgoCD Deployment (Recommended)

The deployment is automated through ArgoCD. Each environment has its own ArgoCD application that watches specific branches:

- Dev: `dev` branch -> `hack-for-facts-dev` namespace
- Production: `main` branch -> `hack-for-facts-prod` namespace

ArgoCD applications are defined in `argocd/applications/`.

## Environment-Specific Configurations

### Development

- Namespace: `hack-for-facts-dev`
- Database: 100Gi storage (CloudNativePG)
- Redis: In-memory only (no persistence)
- Image tag: Updated on each push to `dev` branch
- Host: `api-dev.transparenta.eu`

### Production

- Namespace: `hack-for-facts-prod`
- Database: Larger storage, HA configuration
- Redis: Persistent storage
- Image tag: Updated on each push to `main` branch
- Host: `api.transparenta.eu`

## Updating Secrets

To update secrets for an environment:

1. Create/update the plain secret (locally, never commit):
2. Seal and update:

```bash
# Seal the new secret
kubeseal --format yaml \
  --namespace hack-for-facts-dev \
  < k8s/overlays/dev/secrets/app-secret.yaml \
  > k8s/overlays/dev/secrets/sealed-app-secret.yaml

# Commit and push
git add k8s/overlays/dev/secrets/sealed-app-secret.yaml
git commit -m "Update dev secrets"
git push
```

## Security Notes

1. **Never commit plain secret files** - They contain sensitive credentials
2. Keep the `secrets/*.secret.yaml` files in `.gitignore`
3. Store plain secrets securely (e.g., password manager, vault)
4. Rotate secrets periodically
5. Use different credentials for each environment
6. The `*.secret.yaml` pattern is ignored by git, AI tools, and Docker builds

## Troubleshooting

1. Check sealed secret status:

```bash
kubectl get sealedsecret -n hack-for-facts-<env>
kubectl get secret -n hack-for-facts-<env>
```

2. Check PostgreSQL cluster status (CloudNativePG):

```bash
kubectl get cluster -n hack-for-facts-<env>
kubectl describe cluster postgres-db -n hack-for-facts-<env>
```

3. View application logs:

```bash
kubectl logs -n hack-for-facts-<env> deployment/hack-for-facts-eb-server
```

4. Check pod resource usage:

```bash
kubectl top pods -n hack-for-facts-<env>
```

## Additional Resources

- [Kustomize Documentation](https://kubectl.docs.kubernetes.io/guides/introduction/kustomize/)
- [Sealed Secrets Documentation](https://github.com/bitnami-labs/sealed-secrets)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/)
- [CloudNativePG Documentation](https://cloudnative-pg.io/docs/)
