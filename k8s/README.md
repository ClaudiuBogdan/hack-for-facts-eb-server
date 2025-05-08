# Kubernetes Deployment Guide

This directory contains the Kubernetes manifests for deploying the Musclecode Backend Service. The deployment is structured using Kustomize for environment-specific configurations and sealed-secrets for sensitive data.

## Directory Structure

```
k8s/
├── base/                 # Base configurations
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── postgres-deployment.yaml
│   └── kustomization.yaml
└── overlays/            # Environment-specific configurations
    ├── dev/
    │   ├── kustomization.yaml
    │   └── sealed-db-secret.yaml
    ├── staging/
    │   ├── kustomization.yaml
    │   └── sealed-db-secret.yaml
    └── prod/
        ├── kustomization.yaml
        └── sealed-db-secret.yaml
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
   - Sealed Secrets public key

### Setting Up a New Environment

1. Create environment-specific secret template:

```bash
# Create a directory for your secrets (don't commit this)
mkdir -p k8s/overlays/<env>/secrets

# Create the secret template
cat > k8s/overlays/<env>/secrets/db-secret.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: musclecode-<env>
type: Opaque
stringData:
  POSTGRES_DB: musclecode_<env>
  POSTGRES_USER: musclecode_<env>_user
  POSTGRES_PASSWORD: <your-secure-password>
  DATABASE_URL: postgresql://postgres-db-rw.musclecode-<env>.svc.cluster.local:5432/musclecode_<env>
EOF
```

2. Seal the secret:

```bash
# Seal the secret for the specific environment
kubeseal --format yaml \
  --namespace musclecode-<env> \
  < k8s/overlays/<env>/secrets/db-secret.yaml \
  > k8s/overlays/<env>/sealed-db-secret.yaml
```

3. Commit only the sealed secret:

```bash
git add k8s/overlays/<env>/sealed-db-secret.yaml
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

### ArgoCD Deployment

The deployment is automated through ArgoCD. Each environment has its own ArgoCD application that watches specific branches:

- Dev: `develop` branch
- Staging: `staging` branch
- Production: `main` branch

## Environment-Specific Configurations

### Development
- Namespace: `musclecode-dev`
- Database: 5Gi storage
- Single database instance
- Image tag: `dev`

### Staging
- Namespace: `musclecode-staging`
- Database: 10Gi storage
- Single database instance
- Image tag: `staging`

### Production
- Namespace: `musclecode-prod`
- Database: 20Gi storage
- Two database instances for high availability
- Image tag: `prod`

## Updating Secrets

To update secrets for an environment:

1. Create/update the plain secret:
```bash
# Example for updating dev database password
cat > k8s/overlays/dev/secrets/db-secret.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: musclecode-dev
type: Opaque
stringData:
  POSTGRES_DB: musclecode_dev
  POSTGRES_USER: musclecode_dev_user
  POSTGRES_PASSWORD: new_password
  DATABASE_URL: postgresql://postgres-db-rw.musclecode-dev.svc.cluster.local:5432/musclecode_dev
EOF
```

2. Seal and update:
```bash
# Seal the new secret
kubeseal --format yaml \
  --namespace musclecode-dev \
  < k8s/overlays/dev/secrets/db-secret.yaml \
  > k8s/overlays/dev/sealed-db-secret.yaml

# Commit and push
git add k8s/overlays/dev/sealed-db-secret.yaml
git commit -m "Update dev database credentials"
git push
```

## Security Notes

1. Never commit plain secret files
2. Keep the `secrets/` directory in `.gitignore`
3. Store plain secrets securely (e.g., password manager, vault)
4. Rotate secrets periodically
5. Use different credentials for each environment

## Troubleshooting

1. Check sealed secret status:
```bash
kubectl get sealedsecret -n musclecode-<env>
kubectl get secret -n musclecode-<env>
```

2. Check PostgreSQL cluster status:
```bash
kubectl get postgresql -n musclecode-<env>
kubectl describe postgresql postgres-db -n musclecode-<env>
```

3. View application logs:
```bash
kubectl logs -n musclecode-<env> deployment/musclecode-backend-main-service
```

## Additional Resources

- [Kustomize Documentation](https://kubectl.docs.kubernetes.io/guides/introduction/kustomize/)
- [Sealed Secrets Documentation](https://github.com/bitnami-labs/sealed-secrets)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/) 