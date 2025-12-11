for secret_file in *.secret.yaml; do
    sealed_file="sealed-${secret_file/.secret.yaml/.yaml}"
    kubeseal --format=yaml \
        --controller-namespace=kube-system \
        --controller-name=sealed-secrets-controller \
        --scope strict \
        --namespace=hack-for-facts-dev \
        < "$secret_file" | \
        yq e '.metadata.annotations += {"argocd.argoproj.io/sync-wave": "-5"}' - > "$sealed_file"
done
