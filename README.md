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
