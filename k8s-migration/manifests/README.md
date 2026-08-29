# Secrets handling

`secrets.yaml` in this directory is a **committed template** — its values are
empty placeholders on purpose. Never put real credentials in it.

Real secrets live in `secrets.local.yaml`, which is gitignored
(`backend/.gitignore`) and never leaves this machine. To (re)generate it with
real values:

```bash
kubectl create secret generic sound-scout-secrets \
  --namespace default \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=WORKER_SECRET='...' \
  --from-literal=GEMINI_API_KEY='...' \
  --dry-run=client -o yaml > secrets.local.yaml
```

`deploy-gcp.sh` applies `secrets.local.yaml`, not `secrets.yaml`.

Before deploying, confirm `DATABASE_URL` points at a host reachable from
inside the GKE cluster (e.g. a Cloud SQL instance via the Cloud SQL Auth
Proxy, or a Postgres instance with a private/public IP the cluster can
reach) — `localhost` only works for local dev and will fail from a pod.
