# Deployment & CI/CD Specification

## Reference Document v1.0

---

## 1. Overview

This document defines the deployment architecture for Transparenta.eu, covering CI/CD pipelines, Kubernetes infrastructure, secret management, and operational procedures.

### 1.1 Design Goals

| Goal                   | Description                                                                 |
| :--------------------- | :-------------------------------------------------------------------------- |
| **GitOps**             | Git as single source of truth. All changes via commits, not `kubectl apply` |
| **Environment Parity** | Dev and prod use identical base manifests, differ only via overlays         |
| **Zero-Downtime**      | Rolling deployments with health checks prevent service disruption           |
| **Secret Safety**      | Plain secrets never committed. SealedSecrets for safe Git storage           |
| **Automated Dev**      | Dev deployments fully automated on push                                     |
| **Controlled Prod**    | Production requires explicit promotion (manual gate)                        |

### 1.2 Technology Stack

| Component               | Technology                | Purpose                             |
| :---------------------- | :------------------------ | :---------------------------------- |
| **Container Runtime**   | Docker                    | Build reproducible images           |
| **Container Registry**  | Harbor (self-hosted)      | Private image storage               |
| **Orchestration**       | Kubernetes                | Container scheduling and management |
| **GitOps Controller**   | ArgoCD                    | Sync Git state to cluster state     |
| **Manifest Management** | Kustomize                 | Environment-specific configuration  |
| **Secret Management**   | Sealed Secrets            | Encrypt secrets for Git storage     |
| **Service Mesh**        | Istio                     | Traffic routing, TLS termination    |
| **Database**            | CloudNative-PG            | PostgreSQL operator for K8s         |
| **Cache**               | Redis (Bitnami)           | In-memory caching                   |
| **CI/CD**               | GitHub Actions            | Build, test, push images            |
| **Secret Store**        | Bitwarden Secrets Manager | CI/CD credential storage            |

---

## 2. Architecture

### 2.1 Deployment Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEVELOPER WORKFLOW                             │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────┐    push     ┌──────────────┐   build    ┌─────────────────┐
  │   Dev    │ ─────────▶  │   GitHub     │ ────────▶  │     Harbor      │
  │ Workstation│           │   Actions    │            │    Registry     │
  └──────────┘             └──────┬───────┘            └────────┬────────┘
                                  │                             │
                                  │ update kustomization.yaml   │
                                  ▼                             │
                           ┌──────────────┐                     │
                           │    Git Repo  │                     │
                           │ (image tag)  │                     │
                           └──────┬───────┘                     │
                                  │                             │
┌─────────────────────────────────┼─────────────────────────────┼─────────────┐
│                                 │        ARGOCD GITOPS        │             │
│                                 ▼                             ▼             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         ArgoCD Application                           │   │
│  │   • Watches: k8s/overlays/{env}                                      │   │
│  │   • Syncs: Kustomize manifests → Kubernetes                          │   │
│  │   • Self-heal: Reverts manual cluster changes                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                      │                                      │
│                                      ▼                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Kubernetes Namespace                            │   │
│  │                                                                      │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │   │
│  │   │   App Pod   │  │  PostgreSQL │  │    Redis    │                 │   │
│  │   │ (Fastify)   │  │  (CNPG)     │  │  (Bitnami)  │                 │   │
│  │   └──────┬──────┘  └─────────────┘  └─────────────┘                 │   │
│  │          │                                                           │   │
│  │   ┌──────▼──────┐                                                   │   │
│  │   │   Service   │ ◀──── Istio VirtualService ◀──── External Traffic │   │
│  │   └─────────────┘                                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Environment Strategy

| Environment | Branch | Namespace             | Deployment Trigger          | URL                     |
| :---------- | :----- | :-------------------- | :-------------------------- | :---------------------- |
| **Dev**     | `dev`  | `hack-for-facts-dev`  | Automatic on push           | api-dev.transparenta.eu |
| **Prod**    | `main` | `hack-for-facts-prod` | Manual promotion (merge PR) | api.transparenta.eu     |

**Rationale**: Two-environment strategy (dev → prod) chosen for simplicity. Staging adds operational overhead without proportional value for a small team. The dev environment serves as both feature testing and pre-production validation.

### 2.3 Branch Strategy

```
main (production)
 │
 ├── dev (development/integration)
 │    │
 │    ├── feature/xxx (feature branches)
 │    └── fix/xxx (bug fix branches)
 │
 └── hotfix/xxx (emergency production fixes)
```

**Promotion Path**:

1. Feature branches → merge to `dev` → automatic deployment to dev environment
2. Dev validated → PR from `dev` to `main` → merge triggers prod deployment
3. Hotfixes → PR directly to `main` → immediate prod deployment, then backport to `dev`

---

## 3. Directory Structure

```
├── .github/
│   └── workflows/
│       └── dev-branch.yaml      # Dev CI pipeline
│
├── argocd/
│   └── applications/
│       ├── dev.yaml             # ArgoCD Application for dev
│       └── prod.yaml            # ArgoCD Application for prod
│
├── k8s/
│   ├── base/                    # Shared Kubernetes manifests
│   │   ├── kustomization.yaml   # Base Kustomize config (image tag lives here)
│   │   ├── deployment.yaml      # Application deployment
│   │   ├── service.yaml         # ClusterIP service
│   │   ├── configmap.yaml       # Non-sensitive configuration
│   │   ├── virtual-service.yaml # Istio routing rules
│   │   ├── postgres-deployment.yaml   # Budget database (CNPG)
│   │   ├── postgres-userdata.yaml     # User data database (CNPG)
│   │   └── redis.yaml           # Redis cache
│   │
│   └── overlays/
│       ├── dev/
│       │   ├── kustomization.yaml
│       │   └── secrets/
│       │       ├── sealed-*.yaml           # Encrypted secrets (committed)
│       │       ├── *.secret.yaml           # Plain secrets (gitignored)
│       │       └── convert-secret.sh       # Sealing script
│       │
│       └── prod/
│           ├── kustomization.yaml          # Prod-specific patches
│           └── secrets/
│               └── sealed-*.yaml
│
├── scripts/
│   └── secure-secrets.sh        # Set restrictive permissions on secret files
│
└── Dockerfile                   # Multi-stage production image
```

---

## 4. CI/CD Pipeline

### 4.1 Current Pipeline (Dev Branch)

```yaml
# Triggered on: push to dev branch
# Concurrency: Cancel in-progress runs

┌─────────────────────────────────────────────────────────────────┐
│                    DEV BRANCH PIPELINE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Checkout                                                    │
│     └── Full history (fetch-depth: 0)                           │
│                                                                 │
│  2. Setup Node.js 22                                            │
│     └── Cache: yarn                                             │
│                                                                 │
│  3. Install Dependencies                                        │
│     └── yarn install --frozen-lockfile                          │
│                                                                 │
│  4. Validate Datasets                                           │
│     └── yarn datasets:validate                                  │
│                                                                 │
│  5. Get Secrets (Bitwarden)                                     │
│     └── DOCKER_REGISTRY_URL, DOCKER_USERNAME, DOCKER_PASSWORD   │
│                                                                 │
│  6. Docker Build & Push                                         │
│     └── Tag: {registry}/hack-for-facts-eb-server:{git-sha}      │
│                                                                 │
│  7. Update Kustomization                                        │
│     └── Edit k8s/base/kustomization.yaml with new image tag     │
│                                                                 │
│  8. Commit & Push                                               │
│     └── "ci: update image tag to {sha}"                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ArgoCD detects commit → Syncs to cluster
```

### 4.2 Gap Analysis: Current vs Production-Ready

| Aspect                | Current State           | Production Requirement                    | Priority |
| :-------------------- | :---------------------- | :---------------------------------------- | :------- |
| **Type Checking**     | ❌ Not in pipeline      | `pnpm typecheck` before build             | High     |
| **Linting**           | ❌ Not in pipeline      | `pnpm lint` before build                  | High     |
| **Unit Tests**        | ❌ Not in pipeline      | `pnpm test:unit` before build             | High     |
| **Integration Tests** | ❌ Not in pipeline      | `pnpm test:integration` before build      | High     |
| **Dependency Audit**  | ❌ Not in pipeline      | `pnpm audit` for security vulnerabilities | Medium   |
| **Image Scanning**    | ❌ Not in pipeline      | Trivy or Grype container scan             | Medium   |
| **Package Manager**   | ⚠️ Uses yarn (mismatch) | Should use pnpm (matches package.json)    | Medium   |
| **Main Branch CI**    | ❌ Missing              | Separate workflow for production          | High     |
| **PR Validation**     | ❌ Missing              | Run checks on PRs before merge            | High     |
| **Build Caching**     | ⚠️ Basic yarn cache     | Docker layer caching, pnpm store cache    | Low      |
| **Notifications**     | ❌ None                 | Slack/Discord on failure                  | Low      |

### 4.3 Recommended Pipeline Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         RECOMMENDED CI/CD STRUCTURE                         │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────┐
                    │   PR Validation (all branches)  │
                    │   ─────────────────────────────  │
                    │   • Typecheck                   │
                    │   • Lint                        │
                    │   • Unit tests                  │
                    │   • Integration tests           │
                    │   • Dependency check (circular) │
                    │   • Build (no push)             │
                    └─────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
    ┌───────────────────────────┐   ┌───────────────────────────┐
    │   Dev Deploy (dev branch) │   │  Prod Deploy (main branch)│
    │   ───────────────────────  │   │  ─────────────────────────│
    │   • All PR checks         │   │   • All PR checks         │
    │   • Docker build & push   │   │   • Docker build & push   │
    │   • Update image tag      │   │   • Update image tag      │
    │   • ArgoCD syncs to dev   │   │   • ArgoCD syncs to prod  │
    └───────────────────────────┘   └───────────────────────────┘
```

---

## 5. Kubernetes Architecture

### 5.1 Resource Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    KUBERNETES NAMESPACE: hack-for-facts-{env}               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        APPLICATION LAYER                            │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │  Deployment: hack-for-facts-eb-server                       │   │   │
│  │  │  ─────────────────────────────────────────────────────────   │   │   │
│  │  │  • Image: harbor.devostack.com/hack-for-facts/...:{sha}     │   │   │
│  │  │  • Replicas: 1                                               │   │   │
│  │  │  • Resources: 100m-3 CPU, 128Mi-4Gi memory                   │   │   │
│  │  │  • Health: /health/live, /health/ready          │   │   │
│  │  │  • Env: ConfigMap + SealedSecrets                           │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         DATA LAYER                                  │   │
│  │                                                                     │   │
│  │  ┌────────────────────────┐    ┌────────────────────────┐          │   │
│  │  │ CNPG: postgres-db      │    │ CNPG: postgres-userdata│          │   │
│  │  │ (Budget data)          │    │ (User/auth data)       │          │   │
│  │  │ ──────────────────────  │    │ ────────────────────── │          │   │
│  │  │ • Dev: 100Gi           │    │ • Dev: 50Gi            │          │   │
│  │  │ • Prod: 200Gi + WAL    │    │ • Prod: 200Gi          │          │   │
│  │  │ • PostgreSQL 18        │    │ • PostgreSQL 18        │          │   │
│  │  └────────────────────────┘    └────────────────────────┘          │   │
│  │                                                                     │   │
│  │  ┌────────────────────────┐                                        │   │
│  │  │ Deployment: redis      │                                        │   │
│  │  │ (Cache layer)          │                                        │   │
│  │  │ ──────────────────────  │                                        │   │
│  │  │ • Bitnami Redis        │                                        │   │
│  │  │ • Dev: 768MB maxmem    │                                        │   │
│  │  │ • Prod: 1152MB maxmem  │                                        │   │
│  │  │ • LRU eviction         │                                        │   │
│  │  │ • No persistence       │                                        │   │
│  │  └────────────────────────┘                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       NETWORKING LAYER                              │   │
│  │                                                                     │   │
│  │  ┌────────────────────────┐    ┌────────────────────────┐          │   │
│  │  │ Service: app           │    │ VirtualService (Istio) │          │   │
│  │  │ ClusterIP:80 → 3000    │ ◀──│ api.transparenta.eu    │ ◀── WWW  │   │
│  │  └────────────────────────┘    │ • /mcp: 6h timeout     │          │   │
│  │                                │ • /*: 30s timeout      │          │   │
│  │                                └────────────────────────┘          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 ArgoCD Application Configuration

```yaml
# Key ArgoCD settings for both environments
spec:
  syncPolicy:
    automated:
      prune: true # Delete resources removed from Git
      selfHeal: true # Revert manual cluster changes
    syncOptions:
      - CreateNamespace=true # Auto-create namespace
```

**Rationale**:

- `prune: true` — Ensures deleted manifests are removed from cluster (prevents drift)
- `selfHeal: true` — Reverts any manual `kubectl` changes (enforces GitOps)
- `CreateNamespace=true` — Simplifies initial deployment

### 5.3 Kustomize Strategy

**Base Layer** (`k8s/base/`):

- Contains complete, deployable manifests
- Image tag updated by CI (single source of truth)
- Environment-agnostic configuration

**Overlay Layer** (`k8s/overlays/{env}/`):

- Namespace patches
- Resource limits (prod has higher limits)
- Database storage sizes
- PostgreSQL tuning parameters (prod optimized for analytics)
- Environment-specific hostnames

**Why Kustomize over Helm?**

- Simpler mental model (patches vs templates)
- Native kubectl support
- No templating language to learn
- Better for GitOps (plain YAML in Git)

---

## 6. Secret Management

### 6.1 Secret Types

| Secret                             | Purpose                     | Scope    |
| :--------------------------------- | :-------------------------- | :------- |
| `hack-for-facts-eb-server-secrets` | App secrets (API keys, JWT) | App      |
| `postgres-deployment-credentials`  | Budget DB credentials       | Database |
| `postgres-userdata-credentials`    | User DB credentials         | Database |
| `redis-auth`                       | Redis password              | Cache    |
| `registry-credentials`             | Harbor pull secret          | Registry |

### 6.2 Sealed Secrets Workflow

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        SEALED SECRETS WORKFLOW                            │
└───────────────────────────────────────────────────────────────────────────┘

  Developer Machine                    Git Repository              Kubernetes
  ──────────────────                   ──────────────              ──────────

  1. Create plain secret
     *.secret.yaml (gitignored)
            │
            ▼
  2. Seal with kubeseal
     kubeseal --format yaml \
       --namespace {env} \
       --scope strict \
       < app.secret.yaml \
       > sealed-app-secret.yaml
            │
            ▼
  3. Commit sealed secret ─────────▶  sealed-*.yaml
     (encrypted, safe in Git)              │
                                           │ ArgoCD sync
                                           ▼
                                    SealedSecret resource
                                           │
                                           │ Sealed Secrets Controller
                                           ▼
                                    Secret resource (decrypted)
                                           │
                                           │ Pod mount
                                           ▼
                                    Environment variables
```

### 6.3 Secret Sealing Script

```bash
# k8s/overlays/{env}/secrets/convert-secret.sh

for secret_file in *.secret.yaml; do
    sealed_file="sealed-${secret_file/.secret.yaml/.yaml}"
    kubeseal --format=yaml \
        --controller-namespace=kube-system \
        --controller-name=sealed-secrets-controller \
        --scope strict \
        --namespace=hack-for-facts-{env} \
        < "$secret_file" | \
        yq e '.metadata.annotations += {"argocd.argoproj.io/sync-wave": "-5"}' - \
        > "$sealed_file"
done
```

**Key decisions**:

- `--scope strict` — Secret only works in specified namespace (most secure)
- `sync-wave: "-5"` — Secrets deploy before app (dependency order)

### 6.4 Security Rules

1. **Never commit** `*.secret.yaml` files (enforced via `.gitignore`)
2. **Run** `scripts/secure-secrets.sh` after creating secrets (chmod 600)
3. **Store** plain secrets in password manager (Bitwarden)
4. **Rotate** secrets periodically (manual process currently)
5. **Different credentials** per environment (never share dev/prod secrets)

---

## 7. Database Architecture

### 7.1 Two-Database Design

| Database            | Purpose                       | Characteristics                      |
| :------------------ | :---------------------------- | :----------------------------------- |
| `postgres-db`       | Budget execution data         | Large (200GB), read-heavy, analytics |
| `postgres-userdata` | User accounts, sessions, auth | Small, write-heavy, transactional    |

**Rationale**: Separation allows independent scaling and tuning:

- Budget DB optimized for complex analytical queries
- User DB uses default OLTP settings

### 7.2 CloudNative-PG Operator

Using CNPG instead of vanilla PostgreSQL StatefulSet because:

- Automated failover and recovery
- WAL archiving and PITR backups
- Rolling upgrades
- Connection pooling (PgBouncer)
- Native K8s CRDs

### 7.3 Production PostgreSQL Tuning

```yaml
# Key production settings (k8s/overlays/prod/kustomization.yaml)

# Memory
shared_buffers: '2GB' # 25% of container memory
effective_cache_size: '6GB' # 75% of container memory
work_mem: '64MB' # Per-operation memory
maintenance_work_mem: '512MB' # VACUUM, CREATE INDEX

# Parallelism (read-heavy analytics)
max_parallel_workers_per_gather: '4'
min_parallel_table_scan_size: '1MB'

# Partitioning (budget data is partitioned by year)
enable_partition_pruning: 'on'
enable_partitionwise_join: 'on'
enable_partitionwise_aggregate: 'on'

# JIT (complex queries)
jit: 'on'
jit_above_cost: '100000'

# Maintenance
autovacuum: 'off' # Manual VACUUM after monthly data loads
```

---

## 8. Traffic Routing

### 8.1 Istio VirtualService

```yaml
# Two routing rules based on path

# 1. MCP (Model Context Protocol) - Long-lived streaming
- match:
    - uri:
        prefix: /mcp
  timeout: 6h # SSE connections can be very long
  retries:
    attempts: 0 # No retries for streaming

# 2. Everything else - Standard API
- match:
    - uri:
        prefix: /
  timeout: 30s
  retries:
    attempts: 3
    perTryTimeout: 30s
```

**Rationale**: MCP uses Server-Sent Events for AI agent communication, requiring long timeouts and no retries to maintain connection stability.

---

## 9. Docker Image

### 9.1 Multi-Stage Build

```dockerfile
# Stage 1: Builder
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/package.json /app/yarn.lock ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/datasets ./datasets  # Static data files
RUN yarn install --production --frozen-lockfile
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
```

**Optimization opportunities**:

- Switch from yarn to pnpm (matches package.json)
- Add `.dockerignore` for smaller context
- Use specific base image tag (not just `alpine`)
- Consider distroless for smaller attack surface

### 9.2 Image Tagging Strategy

| Tag Format  | Usage                      | Example                          |
| :---------- | :------------------------- | :------------------------------- |
| `{git-sha}` | Every build (immutable)    | `f25b307111aeb0a9a41acd7ba790b5` |
| `latest`    | Not used (anti-pattern)    | —                                |
| `dev`       | Not used (use SHA instead) | —                                |

**Rationale**: Git SHA tags ensure complete traceability. Every deployment can be traced to exact source code.

---

## 10. Observability Integration

### 10.1 Health Checks

| Probe     | Endpoint        | Initial Delay | Period | Purpose                           |
| :-------- | :-------------- | :------------ | :----- | :-------------------------------- |
| Readiness | `/health/ready` | 5s            | 10s    | Traffic routing (ready to serve)  |
| Liveness  | `/health/live`  | 15s           | 20s    | Container restart (stuck process) |

**Readiness Probe Dependencies**

The readiness probe (`/health/ready`) checks the following infrastructure dependencies:

| Dependency      | Critical | Timeout | Failure Impact          |
| :-------------- | :------- | :------ | :---------------------- |
| `database`      | Yes      | 3s      | Returns 503 (unhealthy) |
| `user-database` | Yes      | 3s      | Returns 503 (unhealthy) |
| `cache`         | No       | 3s      | Returns 200 (degraded)  |

- **Critical dependencies**: Failure results in `unhealthy` status (HTTP 503). Kubernetes stops routing traffic.
- **Non-critical dependencies**: Failure results in `degraded` status (HTTP 200). Traffic continues but with warnings.

**Response Format**

```json
{
  "status": "ok | degraded | unhealthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "uptime": 3600,
  "version": "1.0.0",
  "checks": [
    { "name": "database", "status": "healthy", "latencyMs": 5, "critical": true },
    { "name": "user-database", "status": "healthy", "latencyMs": 3, "critical": true },
    { "name": "cache", "status": "healthy", "latencyMs": 2, "critical": false }
  ]
}
```

**Liveness Probe**

The liveness probe (`/health/live`) does NOT check dependencies - it only verifies the process is alive. This prevents unnecessary pod restarts when external services are temporarily unavailable.

### 10.2 Pod Metadata

Environment variables exposed to application:

```yaml
K8S_POD_NAME       # metadata.name
K8S_NAMESPACE      # metadata.namespace
K8S_NODE_NAME      # spec.nodeName
K8S_DEPLOYMENT_NAME # metadata.labels['app']
APP_VERSION        # metadata.annotations['image-sha']
```

Used for structured logging and distributed tracing correlation.

### 10.3 OpenTelemetry Endpoints

```yaml
OTEL_EXPORTER_OTLP_ENDPOINT: https://example.com
```

---

## 11. Operational Procedures

### 11.1 Deploy to Dev

```bash
# Automatic - just push to dev branch
git checkout dev
git merge feature/my-feature
git push origin dev

# CI will:
# 1. Build and push image
# 2. Update k8s/base/kustomization.yaml
# 3. ArgoCD syncs automatically
```

### 11.2 Promote to Production

```bash
# 1. Ensure dev is stable (check ArgoCD, logs)

# 2. Create PR: dev → main
gh pr create --base main --head dev --title "Release: {description}"

# 3. Review and merge PR
# (Consider: approval requirements, CODEOWNERS)

# 4. ArgoCD detects main branch change, syncs to prod
```

### 11.3 Rollback

```bash
# Option 1: Git revert (preferred - maintains audit trail)
git revert {bad-commit-sha}
git push origin {branch}

# Option 2: ArgoCD UI rollback (emergency)
# ArgoCD → Application → History → Rollback

# Option 3: Manual image tag (emergency)
cd k8s/base
kustomize edit set image harbor.../hack-for-facts-eb-server=...:{known-good-sha}
git commit -am "rollback: revert to {sha}"
git push
```

### 11.4 Secret Rotation

```bash
# 1. Create new secret file
cat > k8s/overlays/prod/secrets/app.secret.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: hack-for-facts-eb-server-secrets
  namespace: hack-for-facts-prod
type: Opaque
stringData:
  JWT_SECRET: "new-rotated-secret"
  # ... other secrets
EOF

# 2. Seal the secret
cd k8s/overlays/prod/secrets
./convert-secret.sh

# 3. Secure permissions
cd ../../../..
./scripts/secure-secrets.sh

# 4. Commit and push
git add k8s/overlays/prod/secrets/sealed-*.yaml
git commit -m "security: rotate production secrets"
git push

# 5. ArgoCD will sync, pods will restart with new secrets
```

### 11.5 Database Maintenance (Production)

```bash
# After monthly data load, run manual VACUUM
kubectl exec -it -n hack-for-facts-prod postgres-db-1 -- \
  psql -U postgres -d hack-for-facts-prod -c "VACUUM ANALYZE;"
```

---

## 12. Decision Log

| Decision                                 | Rationale                                                    |
| :--------------------------------------- | :----------------------------------------------------------- |
| **No staging environment**               | Small team, dev serves as pre-prod. Staging adds overhead.   |
| **ArgoCD over FluxCD**                   | Better UI, project already using it, team familiarity.       |
| **Kustomize over Helm**                  | Simpler for our use case, native GitOps support.             |
| **Sealed Secrets over External Secrets** | Self-contained, no external vault dependency.                |
| **CNPG over vanilla PostgreSQL**         | K8s-native operations, automated failover.                   |
| **Harbor over DockerHub**                | Self-hosted, no rate limits, internal network speed.         |
| **SHA tags over semver**                 | Perfect traceability, no ambiguity about deployed code.      |
| **Manual prod promotion**                | Human gate for production changes, prevents accidents.       |
| **Bitwarden for CI secrets**             | Team already uses Bitwarden, integrates with GitHub Actions. |
| **Autovacuum disabled (prod)**           | Read-heavy workload with monthly batch writes.               |

---

## 13. Future Improvements

### 13.1 High Priority

1. **Complete CI pipeline** — Add typecheck, lint, tests before build
2. **PR validation workflow** — Block merges that fail checks
3. **Production workflow** — Dedicated main branch pipeline
4. **Fix package manager** — Switch Dockerfile from yarn to pnpm

### 13.2 Medium Priority

1. **Container scanning** — Trivy in CI pipeline
2. **Dependency audit** — `pnpm audit` for CVEs
3. **Slack notifications** — Alert on deployment failures
4. **Database backups** — Verify CNPG backup/restore procedures

### 13.3 Low Priority

1. **Docker layer caching** — Reduce build times
2. **Preview environments** — Ephemeral namespaces for PRs
3. **Canary deployments** — Gradual rollout with Istio
4. **GitOps for ArgoCD apps** — App-of-apps pattern

---

## Appendix A: File Reference

| File                                   | Purpose                                |
| :------------------------------------- | :------------------------------------- |
| `.github/workflows/dev-branch.yaml`    | Dev CI pipeline                        |
| `argocd/applications/dev.yaml`         | ArgoCD dev application                 |
| `argocd/applications/prod.yaml`        | ArgoCD prod application                |
| `k8s/base/kustomization.yaml`          | Base Kustomize config (image tag)      |
| `k8s/base/deployment.yaml`             | Application deployment                 |
| `k8s/base/service.yaml`                | ClusterIP service                      |
| `k8s/base/configmap.yaml`              | Non-sensitive config                   |
| `k8s/base/virtual-service.yaml`        | Istio routing                          |
| `k8s/base/postgres-deployment.yaml`    | Budget DB (CNPG)                       |
| `k8s/base/postgres-userdata.yaml`      | User DB (CNPG)                         |
| `k8s/base/redis.yaml`                  | Redis cache                            |
| `k8s/overlays/dev/kustomization.yaml`  | Dev environment patches                |
| `k8s/overlays/prod/kustomization.yaml` | Prod environment patches               |
| `Dockerfile`                           | Multi-stage container build            |
| `scripts/secure-secrets.sh`            | Set restrictive permissions on secrets |
