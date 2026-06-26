# OpenKnowledge
is a fully open-source, free-to-use research literature management and discovery platform. Its goal is to reduce the manual burden placed on researchers when surveying academic literature, enabling them to build a comprehensive and structured understanding of a research area quickly and efficiently.

## Semantic Scholar search (OpenSearch)

The default "Semantic Scholar" search mode runs boolean full-text search (BM25) against a
dedicated **OpenSearch** index of the Semantic Scholar corpus. Two sides:

- **Indexing (one-time / batch):** `deploy/opensearch-ingest/` is a self-contained bundle
  that runs **on the OpenSearch instance** and bulk-loads the BigQuery `papers_search`
  export into OpenSearch. See its README.
- **Querying (the app):** the backend only *reads* from OpenSearch over the network. Set
  `OPENSEARCH_URL` in `backend/.env` to where OpenSearch runs — `http://localhost:9200`
  (or `http://opensearch:9200` in docker-compose) for dev, or
  `http://<instance-internal-ip>:9200` for a remote GCP instance (firewall :9200 to the
  backend only). See `backend/.env.example`.

### Local dev: OpenSearch SSH tunnel

OpenSearch on the GCP `opensearch` VM binds to loopback only and isn't exposed publicly,
so local dev reaches it through an SSH tunnel. Doing this by hand —

```bash
gcloud compute ssh opensearch --zone=europe-west6-a -- -N -L 19200:localhost:9200
```

— means re-running it after every terminal close, laptop sleep, or network blip, and the
backend (`OPENSEARCH_URL=http://localhost:19200`) silently fails until you do.

Instead, install it once as a self-healing **systemd user service**:

```bash
scripts/opensearch-tunnel.sh install   # write unit, enable + start (once)
scripts/opensearch-tunnel.sh status    # is it up?
scripts/opensearch-tunnel.sh logs      # follow logs
scripts/opensearch-tunnel.sh restart
scripts/opensearch-tunnel.sh stop      # stop + disable
```

It starts on login (lingering is enabled, so it can run without an active session) and
restarts automatically on failure — systemd is the supervisor and SSH keepalives make a
dead connection exit so it gets restarted (no `autossh` needed). Stop any manual tunnel on
port 19200 first, or the service can't bind. Override defaults via env vars, e.g.
`INSTANCE=… ZONE=… LOCAL_PORT=… REMOTE_PORT=… scripts/opensearch-tunnel.sh install`.

This is a dev-only convenience: a backend deployed inside the VPC talks to OpenSearch
directly over the internal IP and needs no tunnel.
