# Sealed Secrets Best Practices for Dev Workflow

<!--
@web-flow begin
kind: prompt
id: prompt-20260114081734096
timestamp: "2026-01-14T08:17:34.096Z"
schema: web-flow/research/v1
version: 1
-->

# Deep Research: Sealed Secrets Best Practices for Dev Workflow

## Context

I'm working on a Kubernetes-based application that uses Bitnami Sealed Secrets for secret management. I need to establish best practices for managing sealed secrets across development and production environments with these requirements:

1. **Security**: Prevent accidental exposure of dev and prod secrets in git repositories
2. **Developer Experience (DX)**: Easy workflow to modify, generate, and rotate sealed secrets
3. **Environment Separation**: Clear separation between dev/staging/prod secrets
4. **Auditability**: Track who changed what secrets and when

## Research Questions

### 1. Secret Generation & Management Workflow

- What is the recommended workflow for developers to create and update sealed secrets?
- How should raw secrets be handled during the sealing process? (temporary files, environment variables, stdin)
- What tools/scripts can automate the sealing process while minimizing exposure risk?
- How to handle secret rotation efficiently?

### 2. Repository Structure & Storage

- Should sealed secrets be stored in the same repo as application code or a separate GitOps repo?
- What's the recommended directory structure for sealed secrets across multiple environments?
- How to organize secrets by environment (dev/staging/prod) and by application/service?
- Should there be a separate sealed secrets controller per environment or shared?

### 3. Security Best Practices

- How to prevent raw secrets from being accidentally committed to git?
- What git hooks or CI checks can detect potential secret leaks?
- How to securely share the process of creating/updating secrets among team members?
- What's the recommended key rotation strategy for the sealed secrets controller itself?
- How to handle the sealed secrets private key backup securely?

### 4. Developer Experience Improvements

- What CLI tools or wrappers make sealed secrets easier to work with?
- How to set up local development without needing access to production secrets?
- What IDE integrations or plugins help with sealed secrets management?
- How to create a self-service workflow for developers to update non-sensitive configs?

### 5. CI/CD Integration

- How should sealed secrets be validated in CI pipelines?
- What's the recommended GitOps workflow for sealed secrets changes?
- How to implement approval workflows for production secret changes?
- How to handle sealed secrets in PR reviews (what to check, what to ignore)?

### 6. Alternative Approaches & Comparisons

- How does Sealed Secrets compare to other solutions (External Secrets Operator, HashiCorp Vault, SOPS)?
- When should you consider switching from Sealed Secrets to another solution?
- Can Sealed Secrets be combined with other tools for enhanced security?

### 7. Common Pitfalls & Anti-patterns

- What are the most common mistakes when using Sealed Secrets?
- How to recover from common issues (lost keys, wrong scope, etc.)?
- What are the security risks to be aware of?

## Expected Output

Please provide:

1. A comprehensive guide with actionable recommendations
2. Example scripts or configurations where applicable
3. Comparison tables for different approaches
4. Links to official documentation and community resources
5. Real-world case studies or examples if available
<!-- @web-flow end id=prompt-20260114081734096 -->

<!--
@web-flow begin
kind: response
status: completed
provider: claude
url: "https://claude.ai/chat/af6c2477-fda7-4adf-bff6-827dfa1bd2ba"
id: response-20260114083539797-claude
prompt_id: prompt-20260114081734096
timestamp: "2026-01-14T08:35:39.797Z"
schema: web-flow/research/v1
version: 1
-->

# Bitnami Sealed Secrets: A Complete Best Practices Guide for Kubernetes

**Sealed Secrets remains the most GitOps-native solution for Kubernetes secret management**, encrypting secrets client-side so they can be safely stored in version control. This comprehensive guide establishes best practices across security, developer experience, environment separation, and auditability—covering everything from initial workflow design to disaster recovery.

For teams prioritizing GitOps workflows with minimal infrastructure overhead, Sealed Secrets offers an elegant solution: public-key encryption handled by `kubeseal` CLI, with decryption managed exclusively by an in-cluster controller. The critical insight is that **secrets encrypted for one cluster cannot be decrypted by another**, making environment isolation cryptographically enforced.

## Secret generation workflow keeps plaintext exposure minimal

The safest approach pipes secrets directly through `kubeseal` without ever writing plaintext to disk. The official recommended workflow uses kubectl's `--dry-run=client` flag combined with stdin:

```bash
# Gold standard: never touch filesystem
echo -n "secret-value" | kubectl create secret generic db-creds \
    --dry-run=client \
    --from-file=password=/dev/stdin \
    -o yaml | kubeseal --format yaml > db-creds-sealed.yaml
```

For secrets with multiple key-value pairs, create and seal in one pipeline:

```bash
kubectl create secret generic app-secrets \
    --from-literal=api_key=abc123 \
    --from-literal=db_password=secret456 \
    --dry-run=client -o yaml | kubeseal --format yaml > app-secrets-sealed.yaml
```

**Updating existing sealed secrets** uses the `--merge-into` flag, which adds or updates individual keys without recreating the entire secret:

```bash
echo -n "new-password" | kubectl create secret generic placeholder \
    --dry-run=client --from-file=password=/dev/stdin -o json | \
    kubeseal --format yaml --merge-into existing-sealed-secret.yaml
```

For teams working offline or without cluster access, export the public certificate once and distribute it via your Git repository:

```bash
# Admin exports certificate
kubeseal --fetch-cert \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system > pub-sealed-secrets.pem

# Developers seal offline
kubeseal --cert pub-sealed-secrets.pem --format yaml < secret.yaml > sealed-secret.yaml
```

### Secret rotation requires two distinct processes

A frequently misunderstood aspect: **key renewal is automatic but actual secret rotation is manual**. The controller generates new 4096-bit RSA key pairs every 30 days by default, but old keys remain active for decryption. This means existing sealed secrets continue working—however, if your database password is compromised, you must:

1. Change the credential at the source (database, API provider)
2. Create a new sealed secret with the updated value
3. Commit and deploy through your GitOps pipeline

For re-encrypting existing secrets with the latest key (recommended after key renewal):

```bash
kubeseal --re-encrypt < old-sealed.yaml > new-sealed.yaml && mv new-sealed.yaml old-sealed.yaml
```

## Repository structure should mirror your environment topology

The Argo CD and Flux communities strongly recommend **separate GitOps repositories** for application configuration, with environment-based directory structures rather than branch-based separation:

```
gitops-repo/
├── apps/
│   └── my-application/
│       ├── base/
│       │   ├── deployment.yaml
│       │   └── kustomization.yaml
│       └── overlays/
│           ├── dev/
│           │   ├── sealed-secrets/
│           │   │   └── database-credentials.yaml
│           │   └── kustomization.yaml
│           ├── staging/
│           │   ├── sealed-secrets/
│           │   └── kustomization.yaml
│           └── prod/
│           │   ├── sealed-secrets/
│               └── kustomization.yaml
├── infrastructure/
│   └── sealed-secrets-controller/
└── certs/
    ├── dev-cluster.pem
    ├── staging-cluster.pem
    └── prod-cluster.pem
```

**Each environment's secrets must be encrypted with that environment's specific certificate**—this is cryptographically enforced. Storing certificates in the repository's `certs/` directory enables offline sealing while maintaining clear separation.

### One controller per cluster provides strongest isolation

For production multi-environment setups, **deploy separate Sealed Secrets controllers per cluster**. This ensures:

- Compromised development keys cannot decrypt production secrets
- Different key rotation schedules per environment
- Alignment with least-privilege principles

The alternative—sharing keys across clusters—reduces operational complexity but creates a single point of failure. Only consider shared keys for disaster recovery scenarios or identical development environments.

## Security hardening prevents accidental exposure and unauthorized access

### Pre-commit hooks catch secrets before they reach Git

Gitleaks offers the most comprehensive detection with minimal configuration:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
```

For teams using detect-secrets (Yelp's tool), create a baseline to reduce false positives:

```bash
detect-secrets scan > .secrets.baseline
```

Add patterns to `.gitignore` as defense-in-depth:

```gitignore
# Never commit plaintext secrets
**/secret.yaml
**/secrets/*.yaml
!**/secrets/*-sealed.yaml
.env
*.key
```

### CI pipelines should validate sealed secret structure

GitHub Actions example for comprehensive validation:

```yaml
name: Validate Sealed Secrets
on:
  pull_request:
    paths:
      - '**/*sealed*.yaml'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install kubeseal
        run: |
          curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.26.0/kubeseal-0.26.0-linux-amd64.tar.gz"
          tar -xvzf kubeseal-*.tar.gz kubeseal
          sudo install -m 755 kubeseal /usr/local/bin/

      - name: Validate format
        run: |
          for file in $(find . -name "*sealed*.yaml"); do
            kubeseal --validate < "$file" || exit 1
          done

      - name: Check no raw secrets
        run: |
          if grep -r "kind: Secret$" --include="*.yaml" .; then
            echo "ERROR: Raw Kubernetes Secret found"
            exit 1
          fi

      - name: Scan for leaked credentials
        uses: gitleaks/gitleaks-action@v2
```

### Private key backup is non-negotiable

Without the private key, **sealed secrets are permanently unrecoverable**. Implement automated backups to secure storage:

```bash
# Backup all active sealing keys
kubectl get secret -n kube-system \
    -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
    -o yaml > sealed-secrets-backup.yaml

# Store in AWS Secrets Manager with KMS encryption
aws secretsmanager create-secret \
    --name sealed-secrets-backup-$(date +%Y%m%d) \
    --secret-string "$(cat sealed-secrets-backup.yaml)" \
    --kms-key-id alias/sealed-secrets-backup
```

For regulated environments, store backups in HashiCorp Vault or use AWS SSM Parameter Store with KMS Customer Managed Keys.

### Approval workflows enforce change control

Use CODEOWNERS to require security team review:

```
# .github/CODEOWNERS
**/sealed*.yaml @security-team @platform-team
**/sealedsecret*.yaml @security-team
```

Combine with branch protection rules requiring **minimum 2 reviewers** and passing status checks for production branches.

## Developer experience improvements accelerate adoption

### CLI wrappers reduce friction

**kubeseal-auto** provides an interactive experience that handles common operations:

```bash
pipx install kubeseal-auto

# Interactive mode prompts for all inputs
kubeseal-auto

# Fetch certificate for offline use
kubeseal-auto --fetch

# Edit existing sealed secret (opens decrypted in editor, re-seals on save)
kubeseal-auto --edit secret-name.yaml

# Re-encrypt all secrets in directory
kubeseal-auto --re-encrypt /path/to/directory
```

### Makefile standardizes team workflows

```makefile
SEALED_SECRETS_CERT := certs/$(CLUSTER)-kubeseal.pem
SEALED_SECRETS_NAMESPACE := kube-system

.PHONY: seal-fetch-cert seal-secret seal-all

seal-fetch-cert:
 kubeseal --fetch-cert \
  --controller-namespace=$(SEALED_SECRETS_NAMESPACE) \
  > $(SEALED_SECRETS_CERT)

seal-secret:
 @if [ -z "$(SECRET)" ]; then echo "Usage: make seal-secret SECRET=path/to/secret.yaml"; exit 1; fi
 kubeseal --cert $(SEALED_SECRETS_CERT) --format yaml < $(SECRET) > $(SECRET:.yaml=-sealed.yaml)
 @echo "Delete plaintext: rm $(SECRET)"

seal-all:
 @for f in secrets/*.yaml; do \
  kubeseal --cert $(SEALED_SECRETS_CERT) --format yaml < "$$f" > "$${f%.yaml}-sealed.yaml"; \
 done
```

### Web UIs enable self-service for larger teams

**sealed-secrets-web** (bakito) provides a browser-based interface:

```bash
helm repo add bakito https://charts.bakito.net
helm install sealed-secrets-web bakito/sealed-secrets-web
```

Features include encoding/decoding base64 values, listing all SealedSecrets across namespaces, and a REST API for automation.

### VS Code extension simplifies daily work

The **Kubeseal extension** (codecontemplator.kubeseal) with **7,300+ installs** enables:

- Right-click to seal entire files
- Seal selected text using raw mode
- Configurable certificate path

```json
{
  "kubeseal.executablePath": "/usr/local/bin/kubeseal",
  "kubeseal.useLocalCertificate": true
}
```

### Local development without production secrets

Create environment-specific secret files gitignored for local use:

```bash
# Add to .gitignore
local-secrets/

# Create local development secrets (never sealed, never committed)
kubectl create secret generic app-secrets \
    --from-literal=API_KEY=local-dev-key \
    --dry-run=client -o yaml > local-secrets/dev-app-secrets.yaml
```

## CI/CD and GitOps integration patterns

### Argo CD works natively with Sealed Secrets

No plugins required—Argo CD treats SealedSecrets as standard Kubernetes resources:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sealed-secrets-controller
  namespace: argocd
spec:
  source:
    repoURL: https://bitnami-labs.github.io/sealed-secrets
    chart: sealed-secrets
    targetRevision: 2.16.0
  destination:
    server: https://kubernetes.default.svc
    namespace: kube-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Flux provides native Sealed Secrets support

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: sealed-secrets
  namespace: flux-system
spec:
  chart:
    spec:
      chart: sealed-secrets
      sourceRef:
        kind: HelmRepository
        name: sealed-secrets
  releaseName: sealed-secrets-controller
  targetNamespace: flux-system
```

The Flux workflow: admin installs controller, exports public key to Git, team members seal offline, commit SealedSecrets, Flux reconciles automatically.

### PR review guidelines for sealed secret changes

Reviewers should verify:

- `kind: SealedSecret` (never `Secret`)
- API version `bitnami.com/v1alpha1`
- `encryptedData` fields present (not `data` or `stringData`)
- Appropriate scope annotations if non-default
- No sensitive values in PR description or comments

## Comparing Sealed Secrets with alternatives

| Feature                      | Sealed Secrets  | External Secrets Operator | HashiCorp Vault    | Mozilla SOPS       |
| ---------------------------- | --------------- | ------------------------- | ------------------ | ------------------ |
| **GitOps native**            | ✅ Excellent    | ✅ Good                   | ⚠️ Limited         | ✅ Good            |
| **Setup complexity**         | Simple (1 hour) | Medium (2-4 hours)        | Complex (1-2 days) | Medium (2-4 hours) |
| **Dynamic secrets**          | ❌              | Via provider              | ✅ Built-in        | ❌                 |
| **Auto rotation**            | ❌ Manual       | Via provider              | ✅ Built-in        | ❌ Manual          |
| **Multi-cluster**            | ⚠️ Difficult    | ✅ Easy                   | ✅ Easy            | ⚠️ Medium          |
| **External dependency**      | None            | Required                  | Required           | Optional (KMS)     |
| **Monthly cost (100 nodes)** | ~$200           | ~$530                     | ~$2,400            | ~$200              |

### Decision framework by team size

**Startups and small teams (1-10 engineers)**: Sealed Secrets offers minimal overhead, quick setup, and sufficient security for simple compliance requirements.

**Mid-sized teams (10-50 engineers)**: Consider External Secrets Operator with cloud secret managers (AWS Secrets Manager, Azure Key Vault) for centralized management across multiple clusters.

**Enterprise (50+ engineers)**: HashiCorp Vault with ESO provides comprehensive security features, dynamic secrets, automatic rotation, and compliance-ready auditing.

### Hybrid approaches work well

Common pattern: Use Sealed Secrets to encrypt ESO authentication credentials, then ESO manages application secrets from external stores. This provides secure bootstrap with centralized secret management.

## Common pitfalls and recovery procedures

### Most critical mistake: not backing up private keys

Without backups, **all sealed secrets are permanently unrecoverable**. Test your restore procedure:

```bash
# Restore keys before starting controller
kubectl apply -f sealed-secrets-backup.yaml
kubectl delete pod -n kube-system -l app.kubernetes.io/name=sealed-secrets
```

### Wrong scope causes decryption failures

With `strict` scope (default), both name and namespace are encrypted into the secret. Attempting to rename or move the secret fails. Re-seal with appropriate scope:

```bash
# For secrets that may be renamed
kubeseal --scope namespace-wide < secret.yaml > sealed-secret.yaml

# For shared secrets across namespaces
kubeseal --scope cluster-wide < secret.yaml > sealed-secret.yaml
```

### Key renewal misconception

Teams often panic after 30 days thinking all secrets need re-encryption. **Old keys are retained indefinitely**—the controller maintains all active keys and uses the appropriate one for each sealed secret. No action required unless a key is compromised.

### Bring-your-own-certificates for ephemeral clusters

Development environments with frequent cluster recreation lose decryption capability. Generate persistent keys:

```bash
openssl req -x509 -days 365 -nodes -newkey rsa:4096 \
    -keyout mytls.key -out mytls.crt -subj "/CN=sealed-secrets"
kubectl create secret tls sealed-secrets-custom \
    --cert=mytls.crt --key=mytls.key -n kube-system
kubectl label secret sealed-secrets-custom \
    sealedsecrets.bitnami.com/sealed-secrets-key=active -n kube-system
```

### Controller not found errors in CI

Specify controller namespace explicitly:

```bash
kubeseal --controller-namespace=kube-system \
    --controller-name=sealed-secrets-controller \
    --format yaml < secret.yaml
```

## Conclusion: key recommendations for production success

Sealed Secrets excels for GitOps-first teams with static secrets and single-cluster deployments. The **essential practices** for production readiness:

- **Automate private key backups** to secure storage with every key renewal
- **Use stdin pipelines** to avoid plaintext files touching disk
- **Deploy pre-commit hooks** (gitleaks) as mandatory team configuration
- **Store public certificates in Git** to enable offline sealing
- **Run separate controllers per environment** for cryptographic isolation
- **Implement CODEOWNERS** requiring security review for sealed secret changes
- **Pin controller and CLI versions** to avoid compatibility issues

For teams outgrowing Sealed Secrets—typically at 100+ secrets or 5+ clusters—External Secrets Operator with cloud secret managers provides better scalability without abandoning GitOps principles. The hybrid approach using Sealed Secrets for bootstrap credentials while ESO manages application secrets offers a smooth migration path.

<!-- @web-flow end id=response-20260114083539797-claude -->

<!--
@web-flow begin
kind: response
status: completed
provider: chatgpt
url: "https://chatgpt.com/c/696750a9-31bc-8325-8827-71b342cefe90"
id: response-20260114084344315-chatgpt
prompt_id: prompt-20260114081734096
timestamp: "2026-01-14T08:43:44.315Z"
schema: web-flow/research/v1
version: 1
-->

# ChatGPT pro research

## Recommended baseline architecture

### Core principles

1. **Only sealed artifacts go to Git**: store _only_ `SealedSecret` manifests in Git; never store raw `Secret` manifests (base64 is not encryption).
2. **Per-environment blast-radius**: run **separate Sealed Secrets controllers (and therefore separate keypairs) per environment** (dev/staging/prod), ideally per cluster. Avoid sharing sealing keys across clusters/environments unless you explicitly need portability (it’s an advanced feature and weakens environment separation).
3. **GitOps access controls matter**: Sealed Secrets hides secret _values_ outside the cluster, but **does not authenticate the user** who created/changed a `SealedSecret`. Your Git/GitOps/RBAC controls must prevent unauthorized secret changes from being applied.
4. **Default to strict scope**: keep secrets bound to `(namespace, name)` to prevent reuse/movement. Only widen scope deliberately, with review.
5. **Auditability comes from process**: diffs of encrypted blobs are not human-meaningful (“write-only” model), so use approvals, CODEOWNERS, ticket references, and (for high assurance) external secret managers with audit logs.

---

## 1. Secret generation and management workflow

### Recommended developer workflow (day-to-day)

**Goal:** developers can _create/update_ secrets for dev/staging without ever committing raw material; production changes are gated.

**Workflow**

1. **Get the right public certificate for the target environment**
   - `kubeseal` can fetch the cert from the controller, but that can be brittle in some cluster setups.
   - Recommended: publish environment certs to a trusted internal location and/or commit them to the GitOps repo (public cert is non-secret, but must be the _correct_ one).
   - Note: certificates are automatically renewed every ~30 days; update your offline certs periodically.

2. **Generate Secret manifest locally without writing plaintext files**
   Prefer **stdin pipelines** and/or ephemeral temp files with `umask 077`, never “secret.yaml on disk”.

   Officially supported pattern:
   - Create a Secret manifest locally with `kubectl --dry-run=client`
   - Pipe/convert to SealedSecret with `kubeseal`
   - Commit only the SealedSecret

3. **Seal with strict scope unless there is a concrete reason not to**
   - Strict scope binds encryption to namespace and name; this is a key safety property.

4. **Commit the sealed manifest + reference it from workloads**
   The controller will unseal into a normal Kubernetes `Secret` at runtime.

---

### Raw secret handling during sealing (avoid exposure)

**Main risks**

- Shell history (`--from-literal=password=...`)
- Process list exposure (passing secrets as CLI args)
- Plaintext files left behind
- Copy/paste into PRs or chat

**Best practice hierarchy**

1. **Stdin into `kubectl create secret ... --from-file=...=/dev/stdin`** (reduces CLI exposure)
2. **Ephemeral temp files** only if required (strict perms, trap cleanup)
3. **Avoid `--from-literal` for sensitive values** (it embeds secrets in the command line)

---

### Example: “safe-by-default” sealing script

Create `scripts/seal-secret.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   printf %s "$VALUE" | ./scripts/seal-secret.sh <env> <namespace> <secret_name> <key> <out_file>
#
# Example:
#   printf %s "$DB_PASSWORD" | ./scripts/seal-secret.sh dev myapp db-auth password \
#     clusters/dev/myapp/secrets/db-auth.sealedsecret.yaml

ENV="${1:?env}"
NAMESPACE="${2:?namespace}"
NAME="${3:?secret_name}"
KEY="${4:?key}"
OUT="${5:?out_file}"

CERT="certs/${ENV}.pem"
if [[ ! -f "$CERT" ]]; then
  echo "Missing cert: $CERT" >&2
  exit 1
fi

umask 077

# Read secret value from stdin, pipe through kubectl -> kubeseal, never write plaintext to disk
cat /dev/stdin \
  | kubectl -n "$NAMESPACE" create secret generic "$NAME" \
      --dry-run=client -o yaml \
      --from-file="${KEY}=/dev/stdin" \
  | kubeseal --format yaml --cert "$CERT" \
  > "$OUT"

echo "Wrote sealed secret: $OUT" >&2
```

Notes:

- This keeps raw values off disk.
- The only file created is the sealed output.

Supporting facts:

- Offline cert usage (`kubeseal --fetch-cert` + `kubeseal --cert`) is an intended workflow; certs renew periodically.
- Sealing from a locally generated Secret manifest is the standard usage pattern.

---

### Updating secrets efficiently (without re-sealing everything)

1. **Update just one key in a multi-key secret** using `--merge-into`
   This helps when a secret has many keys and you only want to add/replace one item.

Example:

```bash
echo -n "newvalue" \
  | kubectl -n myns create secret generic mysecret --dry-run=client --from-file=somekey=/dev/stdin -o json \
  | kubeseal --merge-into clusters/dev/myns/secrets/mysecret.sealed.json
```

1. **Validate sealed secrets** (optional but useful) with `kubeseal --validate`
   This checks whether a sealed secret can be decrypted (typically requires cluster/controller access).

---

### Secret rotation

You need to rotate **two layers**:

1. **Sealing key renewal (controller keys)**

- Controller automatically renews sealing keys every ~30 days by default, and keeps old keys so existing SealedSecrets remain decryptable.
- You can tune renewal period using `--key-renew-period` (controller flag) or Helm chart value `keyRenewPeriod`.

1. **User secret rotation (actual passwords/tokens)**

- Key renewal/re-encryption is **not a substitute** for rotating the real secret values. Treat anything ever committed to VCS as potentially permanent history; if a sealing key leaks, those past sealed resources must be assumed compromised.

**Recommended rotation runbook**

- Rotate the real credential at the source (DB password, API token, etc.)
- Regenerate SealedSecret with new value
- Deploy via GitOps
- Verify workloads roll and consume the new secret

**Compromise response**

- Force early sealing key renewal _before_ re-sealing new rotated values using `--key-cutoff-time` / `SEALED_SECRETS_KEY_CUTOFF_TIME`.

---

## 2. Repository structure and storage

### Same repo vs separate GitOps repo

**Recommended (common GitOps practice): separate config repo**

- Argo CD explicitly recommends separating application source code from Kubernetes manifests/config for separation of concerns, cleaner audit history, and separation of access (especially for production).

**When a single repo can be acceptable**

- Small team, strong branch protections, and clear separation via directories + CODEOWNERS.
- But you must still prevent CI loops and limit who can push to prod paths (Argo calls this out).

### Recommended directory structure (multi-env, multi-app)

Use a structure aligned with Flux’s documented patterns (apps/infrastructure/clusters with env overlays).

Example (monorepo-style GitOps repo):

```text
repo/
  apps/
    myapp/
      base/
        deployment.yaml
        service.yaml
      overlays/
        dev/
          kustomization.yaml
          secrets/
            db-auth.sealedsecret.yaml
        staging/
          kustomization.yaml
          secrets/
            db-auth.sealedsecret.yaml
        prod/
          kustomization.yaml
          secrets/
            db-auth.sealedsecret.yaml

  infrastructure/
    base/
    overlays/
      dev/
      staging/
      prod/

  clusters/
    dev/
      kustomization.yaml
    staging/
      kustomization.yaml
    prod/
      kustomization.yaml

  certs/
    dev.pem
    staging.pem
    prod.pem

  scripts/
    seal-secret.sh
```

Key points:

- Secrets live **inside the env overlay** so it’s obvious which environment they target.
- Certificates are per environment; safe to store in Git but must be correct and kept up to date.

### Organizing by application/service

Within each environment overlay:

- One directory per app: `apps/<app>/overlays/<env>/secrets/`
- Prefer one SealedSecret per logical secret (db auth, oauth credentials, etc.) to keep changes localized.

### One controller per environment vs shared

**Recommended: one controller per environment (and per cluster)**

- Strong environment separation and reduced blast radius if keys are compromised.

**If dev/staging/prod share a cluster**

- Prefer separate namespaces and:
  - strict scope (default)
  - separate Git paths + approvals
  - optionally restrict controller namespace coverage via `--additional-namespaces` / `additionalNamespaces` (controller only manages specific namespaces).

---

## 3. Security best practices

### Prevent raw secrets from being committed

**Repository controls**

- `.gitignore` entries for common plaintext artifacts:
  - `*.env`, `.env.*`
  - `*.secret.yaml`, `*.secret.yml`
  - `secrets.local/`, `tmp/`

- PR templates that explicitly ask: “Did you generate any plaintext Secret files? Confirm deleted.”

**Local pre-commit hooks (fast feedback)**

- `detect-secrets` (Yelp) is designed as a pre-commit hook with heuristics; it’s not perfect but catches obvious leaks.
- You can complement with Gitleaks locally/CI.

Example `.pre-commit-config.yaml` (detect-secrets):

```yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']
```

**CI backstop scanning**

- **Gitleaks**: scans repos/files/stdin for secrets; suitable for CI.
- **TruffleHog**: broad discovery and analysis for leaked credentials across sources including git.

Example GitHub Actions job (Gitleaks):

```yaml
jobs:
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
```

(Use the action’s documentation to pin versions and configure allowlists.)

**Platform-level protection**

- If you use GitHub, enable **push protection** so pushes are blocked if secrets are detected during the push.

---

### Secure sharing / team workflow

- Share only **public certs** for each environment; they are not secret, but correctness matters.
- Share raw secret values via a **dedicated secret channel** (password manager, secret manager, vault) rather than chat/PR. (Process recommendation; not specific to Sealed Secrets.)

### Sealed Secrets controller key rotation strategy

- Keep default automatic renewal unless you have a strong reason to change it; old keys remain needed to decrypt existing resources.
- Tune renewal with `--key-renew-period` / Helm `keyRenewPeriod` if your compliance requires different cadence.
- On suspected compromise: generate a new key immediately using `--key-cutoff-time`, then rotate actual secrets and re-seal.

### Private key backup (critical)

If you lose the controller’s private keys and do not have decrypted secrets elsewhere, you will have to regenerate credentials and reseal.

**Backup**

```bash
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > main.key

echo "---" >> main.key
kubectl get secret -n kube-system sealed-secrets-key -o yaml >> main.key
```

Keep that backup extremely protected; after key renewal, re-create the backup so it includes newly generated keys.

**Restore**

- Apply the backup secrets back to the controller namespace and restart the controller pods.

**Offline recovery (advanced)**

- If you have backup private keys, you can decrypt a sealed secrets file using `kubeseal --recovery-unseal ...`.

---

## 4. Developer experience improvements

### CLI/tooling improvements

- Wrap `kubectl + kubeseal` in scripts/Make targets (as shown) so developers don’t invent risky one-offs.
- Use `kubeseal --raw` when you want editor/IDE integration or to avoid creating a temp Secret manifest; but it requires strict correctness for scope/namespace/name.
- Community tools and integrations:
  - `kseal` companion tool
  - `kubeseal-convert`
  - VS Code extension
  - WebSeal (browser-based generation)

### Local development without production secrets

Recommended pattern:

- Developers run local services with **local-only secrets** (env vars, local `.env` ignored, local secret store) and/or a **local dev cluster** (kind/k3d) with its own sealed-secrets controller.
- Dev/staging use separate credentials from prod; never “copy prod secret into dev”.

This matches the Sealed Secrets model: anyone can seal, only the target cluster can unseal.

### Self-service for non-sensitive config

- Keep non-sensitive config in ConfigMaps/values and allow developers to update via PR without involving security review.
- For sensitive config (secrets), enforce stricter approval.

---

## 5. CI/CD and GitOps integration

### CI validation strategy (practical)

Use layered checks:

1. **Schema/structure validation (no cluster required)**

- Validate YAML is valid and CRDs are well-formed (e.g., `kubeconform` with CRD schemas).
- Enforce policy checks (OPA/Kyverno) for:
  - No `kind: Secret` under `clusters/prod/**`
  - No `data:` keys in `Secret` manifests
  - SealedSecret must be strict scope unless explicitly annotated

1. **Secret leak scanning**

- Pre-commit + CI scanners (Gitleaks/TruffleHog/detect-secrets) as described above.

1. **Cryptographic/cluster validation (optional, gated)**

- Run `kubeseal --validate` in a protected CI job that has access to the target cluster/controller to confirm decryptability.

### Recommended GitOps workflow for sealed secrets changes

- Commit SealedSecret manifest to GitOps repo; GitOps controller applies it; sealed-secrets controller unseals into `Secret`.

### Approval workflows for production secret changes

Implement in Git (because Sealed Secrets itself does not authenticate intent):

- `CODEOWNERS` for prod secret paths
- Mandatory PR approvals (SRE + Security)
- Branch protection (no direct pushes)
- Signed commits for high assurance (optional but common)

Example `CODEOWNERS`:

```text
# Prod secrets require platform + security approval
apps/**/overlays/prod/secrets/**  @platform-team @security-team
clusters/prod/**/secrets/**       @platform-team @security-team
```

### PR review guidance (what to check / ignore)

**Check**

- Correct environment path (`overlays/prod/...`)
- Correct namespace/name (matches workload references)
- Scope annotations: avoid cluster-wide unless justified
- Secret type/immutable/template metadata (labels, annotations)
- No plaintext `Secret` resources included
- Rotation ticket reference in annotations/commit message

**Ignore**

- Ciphertext diffs: encryption is randomized; the blob will change even for small edits.

---

## 6. Alternatives and comparisons

### Comparison table

| Solution                            | Where secret _values_ live                          | Git contains                                                  | Can devs decrypt?                       | Rotation support                                                           | Auditability                                                          | Operational complexity | Best fit                                                          |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| **Sealed Secrets**                  | Kubernetes (unsealed `Secret`), encrypted outside   | Encrypted `SealedSecret`                                      | Typically **no** (write-only model)     | Controller key renewal + you must rotate real secrets                      | Git shows who/when; ciphertext not human-auditable; relies on process | Low–medium             | Simple GitOps encryption; teams that want “commit safe artifacts” |
| **External Secrets Operator (ESO)** | External secret manager + synced into Kubernetes    | References to provider keys (`ExternalSecret`, `SecretStore`) | Usually **no** (they don’t need values) | Strong if provider supports rotation; reconciles changes automatically     | Stronger (provider audit logs + Git changes)                          | Medium                 | Production with compliance/audit needs; centralized secrets       |
| **HashiCorp Vault (or similar)**    | Vault (dynamic/leased secrets possible)             | Usually references/config only                                | No (unless granted)                     | Strong (dynamic secrets, leases)                                           | Strong (Vault audit devices)                                          | High                   | Large orgs, dynamic creds, strong governance                      |
| **SOPS**                            | Encrypted files in Git (decryptable by key holders) | Encrypted YAML/JSON/ENV/etc                                   | Yes (for key holders)                   | Supports key management and rotation patterns; integrates with KMS/age/PGP | Better diffs possible (values encrypted, structure visible)           | Medium                 | Teams who need readable diffs and authorized local editing        |

### When to consider switching away from Sealed Secrets

Consider ESO/Vault/SOPS if you need:

- Strong audit logs of secret access and/or centralized governance
- Automatic rotation and synchronization from an external provider
- Human-reviewable diffs of secret files (with controlled decryption)

### Combining approaches (common “best of both”)

- Use **ESO/Vault** for production runtime secrets (source of truth outside Git).
- Use **Sealed Secrets** only for bootstrap credentials (if needed) or for low-risk secrets where GitOps simplicity matters.
  This aligns with ESO’s model of synchronizing from external APIs and separating auth/access concerns.

---

## 7. Common pitfalls, anti-patterns, and recovery

### Pitfalls / anti-patterns

1. **Committing plaintext Secret YAML** (base64 is trivial to decode).
2. **Relying on sealing key renewal instead of rotating real secrets**.
3. **Using cluster-wide scope by default** (weakens namespace/name binding protections).
4. **Assuming Sealed Secrets provides authorization**: anyone can create a SealedSecret; your process must control what gets applied.
5. **Deleting old sealing keys** without re-encrypting/migrating can break decryptability of existing sealed secrets. (Old keys are intentionally retained.)
6. **Not updating offline certs**: certs renew; stale cert distribution breaks dev workflow.

### Recovery scenarios

- **Lost controller keys, no backup**: you cannot decrypt old sealed secrets; you must regenerate new credentials and reseal.
- **Wrong scope/namespace/name**: re-seal with correct metadata; strict scope ties to `(namespace, name)`.
- **Need to re-encrypt to latest key**: use `kubeseal --re-encrypt` (doesn’t expose secrets to the client; does not update in-cluster object automatically).

---

## Official docs and high-signal resources

### Sealed Secrets

- Bitnami Sealed Secrets GitHub (usage, scopes, rotation, backup, related tools).
- Flux guide: installing controller, fetching/storing cert, GitOps workflow.
- AWS Open Source Blog: end-to-end explanation and GitOps integration context.

### GitOps repo structure

- Argo CD: best practices on separating config vs source repos (audit/access reasons).
- Flux: repository structure patterns and environment overlays.

### Secret leak prevention tooling

- Gitleaks (repo + CI usage).
- Yelp detect-secrets (pre-commit).
- TruffleHog (repo).
- GitHub push protection (blocks pushing secrets).

### Alternatives

- External Secrets Operator overview (model, access control notes, multi-controller).
- SOPS (formats + encryption backends: KMS/age/PGP).

---

## Real-world examples / references

- **AWS Open Source Blog**: describes Sealed Secrets in a CI/CD + GitOps context and explains namespace/name binding in the encryption flow.
- **Flux documentation**: a concrete GitOps workflow including publishing the public cert, sealing offline, and committing sealed manifests.

---

## Minimum “best practices” checklist (implementation-ready)

**Environment separation**

- [ ] Separate controllers + keys per env/cluster
- [ ] Separate cert files per env in repo (`certs/dev.pem`, `certs/prod.pem`)
- [ ] Strict scope default

**Developer workflow**

- [ ] Wrapper script(s) that seal via stdin and output to correct env folder
- [ ] No plaintext Secret files written to disk (or aggressively `.gitignore` + hooks)

**Security**

- [ ] Pre-commit detect-secrets (or equivalent)
- [ ] CI gitleaks/trufflehog scan
- [ ] GitHub push protection enabled (if on GitHub)
- [ ] CODEOWNERS for prod secrets paths + branch protection

**Operations**

- [ ] Regular backup of controller private keys; re-backup after key renewals
- [ ] Compromise runbook: early key renewal + rotate real secrets + reseal

If you want a stricter “prod-grade” model: use ESO/Vault for production secret values and keep Sealed Secrets only for bootstrapping or low-risk secrets.

<!-- @web-flow end id=response-20260114084344315-chatgpt -->

---

# Project Implementation Summary: Sealed Secrets for transparenta.eu

## Current State Assessment

Based on the codebase analysis, this project already has:

**Existing Structure:**

```
k8s/overlays/
├── dev/secrets/
│   ├── sealed-app-secret.yaml        ✅ Sealed
│   ├── sealed-db-deployment.yaml     ✅ Sealed
│   ├── sealed-db-user-deployment.yaml ✅ Sealed
│   ├── sealed-redis-auth.yaml        ✅ Sealed
│   ├── sealed-registry-secret.yaml   ✅ Sealed
│   └── *.secret.yaml                 ⚠️ Raw (gitignored)
└── prod/secrets/
    ├── sealed-*.yaml                 ✅ Sealed
    └── *.secret.yaml                 ⚠️ Raw (gitignored)
```

**What's Already Good:**

- ✅ Separate secrets per environment (dev/prod)
- ✅ Raw `.secret.yaml` files are in `.gitignore`
- ✅ Sealed secrets follow naming convention
- ✅ Structure aligns with Kustomize overlays pattern

**Gaps to Address:**

- ❌ No public certificates stored in repo for offline sealing
- ❌ No sealing helper scripts for consistent DX
- ❌ No pre-commit hooks for secret leak detection
- ❌ No CI validation for sealed secrets
- ❌ No documented workflow for secret rotation
- ❌ No private key backup strategy documented

---

## Recommended Implementation Plan

### Phase 1: Secure the Foundation (Immediate)

#### 1.1 Add Pre-commit Secret Detection

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
```

Install and initialize:

```bash
pip install pre-commit
pre-commit install
```

#### 1.2 Store Public Certificates in Repo

Create certificates directory:

```bash
mkdir -p k8s/certs
```

Fetch certificates from each cluster:

```bash
# For dev cluster
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --context=dev-cluster > k8s/certs/dev.pem

# For prod cluster
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --context=prod-cluster > k8s/certs/prod.pem
```

**Note:** Certificates renew every ~30 days. Set a reminder to update them.

#### 1.3 Create Sealing Helper Script

Create `scripts/seal-secret.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   printf '%s' "$VALUE" | ./scripts/seal-secret.sh <env> <namespace> <secret_name> <key>
#
# Example:
#   printf '%s' "$DB_PASSWORD" | ./scripts/seal-secret.sh dev transparenta db-auth password

ENV="${1:?Usage: seal-secret.sh <env> <namespace> <secret_name> <key>}"
NAMESPACE="${2:?namespace required}"
NAME="${3:?secret_name required}"
KEY="${4:?key required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CERT="$PROJECT_ROOT/k8s/certs/${ENV}.pem"
OUT="$PROJECT_ROOT/k8s/overlays/${ENV}/secrets/sealed-${NAME}.yaml"

if [[ ! -f "$CERT" ]]; then
  echo "❌ Missing cert: $CERT" >&2
  echo "Run: kubeseal --fetch-cert ... > $CERT" >&2
  exit 1
fi

umask 077

cat /dev/stdin \
  | kubectl -n "$NAMESPACE" create secret generic "$NAME" \
      --dry-run=client -o yaml \
      --from-file="${KEY}=/dev/stdin" \
  | kubeseal --format yaml --cert "$CERT" \
  > "$OUT"

echo "✅ Wrote sealed secret: $OUT" >&2
```

Make executable:

```bash
chmod +x scripts/seal-secret.sh
```

#### 1.4 Add Makefile Targets

Add to `Makefile` or create `Makefile.secrets`:

```makefile
.PHONY: seal-fetch-certs seal-secret-dev seal-secret-prod

SEALED_SECRETS_NS := kube-system
SEALED_SECRETS_NAME := sealed-secrets-controller

seal-fetch-certs:
	@echo "Fetching certificates..."
	kubeseal --fetch-cert --controller-name=$(SEALED_SECRETS_NAME) \
		--controller-namespace=$(SEALED_SECRETS_NS) --context=dev-cluster > k8s/certs/dev.pem
	kubeseal --fetch-cert --controller-name=$(SEALED_SECRETS_NAME) \
		--controller-namespace=$(SEALED_SECRETS_NS) --context=prod-cluster > k8s/certs/prod.pem
	@echo "✅ Certificates updated"

seal-secret-dev:
	@if [ -z "$(SECRET)" ] || [ -z "$(KEY)" ]; then \
		echo "Usage: make seal-secret-dev SECRET=<name> KEY=<key>"; \
		echo "Then paste value and press Ctrl+D"; \
		exit 1; \
	fi
	@./scripts/seal-secret.sh dev transparenta $(SECRET) $(KEY)

seal-secret-prod:
	@if [ -z "$(SECRET)" ] || [ -z "$(KEY)" ]; then \
		echo "Usage: make seal-secret-prod SECRET=<name> KEY=<key>"; \
		echo "Then paste value and press Ctrl+D"; \
		exit 1; \
	fi
	@./scripts/seal-secret.sh prod transparenta $(SECRET) $(KEY)
```

---

### Phase 2: CI/CD Integration (Next Sprint)

#### 2.1 Add GitHub Actions Validation

Create `.github/workflows/validate-secrets.yml`:

```yaml
name: Validate Sealed Secrets

on:
  pull_request:
    paths:
      - 'k8s/**/sealed-*.yaml'
      - 'k8s/**/secrets/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check no raw secrets committed
        run: |
          if find k8s -name "*.secret.yaml" | grep -q .; then
            echo "❌ ERROR: Raw secret files found!"
            find k8s -name "*.secret.yaml"
            exit 1
          fi

      - name: Validate sealed secret structure
        run: |
          for file in $(find k8s -name "sealed-*.yaml"); do
            echo "Validating: $file"
            if ! grep -q "kind: SealedSecret" "$file"; then
              echo "❌ ERROR: $file is not a SealedSecret"
              exit 1
            fi
            if grep -q "^  data:" "$file" || grep -q "^  stringData:" "$file"; then
              echo "❌ ERROR: $file contains unencrypted data"
              exit 1
            fi
          done
          echo "✅ All sealed secrets valid"

      - name: Scan for leaked credentials
        uses: gitleaks/gitleaks-action@v2
```

#### 2.2 Add CODEOWNERS for Production Secrets

Create/update `.github/CODEOWNERS`:

```
# Production secrets require security review
k8s/overlays/prod/secrets/** @platform-team @security-lead
k8s/certs/prod.pem @platform-team @security-lead
```

---

### Phase 3: Operations & Disaster Recovery

#### 3.1 Private Key Backup Procedure

**Critical:** Without private keys, sealed secrets cannot be decrypted.

Create `scripts/backup-sealing-keys.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DATE=$(date +%Y%m%d)
BACKUP_DIR="./secrets-backup-${BACKUP_DATE}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

for ENV in dev prod; do
  echo "Backing up $ENV sealing keys..."
  kubectl get secret -n kube-system \
    -l sealedsecrets.bitnami.com/sealed-secrets-key \
    --context="${ENV}-cluster" \
    -o yaml > "${BACKUP_DIR}/${ENV}-sealing-keys.yaml"
done

echo "⚠️  Store ${BACKUP_DIR}/ in a secure location (vault, encrypted storage)"
echo "⚠️  Delete local copy after secure storage"
```

**Recommended backup locations:**

- AWS Secrets Manager with KMS encryption
- HashiCorp Vault
- Encrypted cloud storage with MFA

#### 3.2 Key Rotation Runbook

Document in `docs/runbooks/secret-rotation.md`:

```markdown
# Secret Rotation Runbook

## When to Rotate

- Suspected credential compromise
- Employee offboarding with secret access
- Regular rotation schedule (quarterly recommended)

## Steps

1. Generate new credential at source (DB, Redis, API provider)
2. Create new sealed secret:
   \`\`\`bash
   printf '%s' "$NEW_VALUE" | make seal-secret-prod SECRET=db-auth KEY=password
   \`\`\`
3. Commit and push to trigger GitOps sync
4. Verify application restarts and uses new credential
5. Revoke old credential at source
```

---

## Developer Workflow Quick Reference

### Creating a New Secret (Dev)

```bash
# Option 1: Using helper script
printf '%s' "my-secret-value" | ./scripts/seal-secret.sh dev transparenta my-secret key-name

# Option 2: Using make
printf '%s' "my-secret-value" | make seal-secret-dev SECRET=my-secret KEY=key-name
```

### Updating an Existing Secret

```bash
# Use --merge-into to update a single key
echo -n "new-value" | kubectl create secret generic placeholder \
  --dry-run=client --from-file=password=/dev/stdin -o json | \
  kubeseal --cert k8s/certs/dev.pem --merge-into k8s/overlays/dev/secrets/sealed-db-auth.yaml
```

### Verifying Sealed Secrets (requires cluster access)

```bash
kubeseal --validate < k8s/overlays/dev/secrets/sealed-db-auth.yaml
```

---

## Security Checklist

### Before Committing

- [ ] No `.secret.yaml` files staged (`git status`)
- [ ] Only `sealed-*.yaml` files in secrets directories
- [ ] Pre-commit hooks installed and passing

### For Production Changes

- [ ] PR approved by security/platform team
- [ ] No plaintext values in PR description or comments
- [ ] Rotation ticket linked (if applicable)

### Quarterly Operations

- [ ] Update public certificates from clusters
- [ ] Backup private sealing keys
- [ ] Review and rotate any long-lived credentials
- [ ] Test disaster recovery procedure

---

## Decision: Stay with Sealed Secrets or Migrate?

Based on the research, **Sealed Secrets is the right choice for this project** because:

| Factor                  | Assessment                              |
| ----------------------- | --------------------------------------- |
| Team size               | Small team → Sealed Secrets is ideal    |
| Secret count            | <50 secrets → No scalability concerns   |
| Cluster count           | 2 (dev/prod) → Manageable               |
| GitOps workflow         | Already using GitOps → Native fit       |
| Infrastructure overhead | Minimal → No external dependencies      |
| Compliance needs        | Standard → Sufficient for current needs |

**When to reconsider:**

- If you need dynamic secrets (auto-rotating DB passwords)
- If you grow to 5+ clusters
- If you need comprehensive audit logs for compliance
- If secrets exceed 100+ across environments

**Potential hybrid future:** Use Sealed Secrets to bootstrap ESO credentials, then ESO for application secrets from a cloud secret manager.

---

## Immediate Action Items

1. **Today:**
   - [ ] Install gitleaks pre-commit hook
   - [ ] Create `k8s/certs/` directory with public certificates
   - [ ] Create `scripts/seal-secret.sh` helper`

2. **This Week:**
   - [ ] Add CI validation workflow
   - [ ] Set up CODEOWNERS for prod secrets
   - [ ] Document workflow in team wiki

3. **This Month:**
   - [ ] Implement private key backup procedure
   - [ ] Create rotation runbook
   - [ ] Train team on new workflow
