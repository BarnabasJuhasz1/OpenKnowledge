# Connect backend to live OpenSearch — 02: live connection config + boolean verification

## Goal
Point the dev backend at the live OpenSearch node on the GCP instance and prove that real
boolean queries return the currently-searchable papers.

## Connection model (security-aware)
The live node runs single-node with the security plugin DISABLED (plain HTTP on :9200).
Exposing :9200 publicly would let anyone read/delete the index, so we do NOT open the
firewall to the laptop. Two supported paths:

- **Dev (laptop): SSH tunnel.** No firewall change; nothing exposed.
  `gcloud compute ssh opensearch --zone=europe-west6-a -- -N -L 9200:localhost:9200`
  Then the existing `OPENSEARCH_URL=http://localhost:9200` in `backend/.env` works as-is.
- **Deployed backend (same VPC):** `OPENSEARCH_URL=http://<internal-ip>:9200`
  (10.172.0.4), with the firewall allowing :9200 only from the backend host's internal IP.

`backend/.env.example` already documents both; keep it accurate. No secret/key files move.

## Verify (with the tunnel up, or on the node directly)
1. `engine.ping()` is True and `engine.searchable_count()` returns the live refreshed count.
   (During ingest the loader sets `refresh_interval=-1`, so this is the last-refreshed set;
   `POST /papers/_refresh` exposes in-flight docs if a fuller snapshot is wanted for testing.)
2. Boolean correctness on live data — the set-algebra identity that proves AND/OR/NOT map
   correctly: for two terms, `hits(A AND B) + hits(A NOT B) == hits(A)`. Run via the engine
   (or the compiled DSL through curl) against the live index and confirm the identity holds
   and latencies are reasonable.
3. The scholar endpoint returns results end-to-end for a raw boolean query.

## Done when
Live `ping`/`count` succeed, the AND/OR/NOT identity holds on the live index, and the
`/retrieval/scholar/search` path returns mapped papers. Record the observed counts/latency.
