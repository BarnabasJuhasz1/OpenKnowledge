# OpenSearch ingestion bundle

Everything needed on the **GCP OpenSearch instance** to load the Semantic Scholar corpus
from BigQuery (`papers_search`) into a local OpenSearch index. Nothing else from the repo
is required here — the FastAPI backend runs elsewhere and talks to this instance over the
network (`OPENSEARCH_URL=http://<instance-ip>:9200`).

## Contents
```
opensearch-ingest/
  .env.example                     # copy to .env, edit
  requirements.txt                 # 3 python deps
  docker-compose.opensearch.yml    # optional: run OpenSearch via Docker on the SSD
  scripts/
    ingest_opensearch.py           # the loader (resumable)
    opensearch_index.json          # index mapping (number_of_shards=5 for the full corpus)
```
The loader reads `.env` from this directory (one level above `scripts/`) and the mapping
from `scripts/opensearch_index.json`, so keep this layout intact.

## 1. Copy to the instance
```
gcloud compute scp --recurse Repo/deploy/opensearch-ingest <instance>:~/  # or scp/rsync
```

## 2. OpenSearch on the instance (skip if already running)
Point its data dir at the 250 GB SSD. Either your existing install (set `path.data` to the
mount, heap `-Xmx` to ~50% RAM, `vm.max_map_count=262144`), or the bundled Docker compose:
```
# persist the kernel setting so it survives reboots (the -w form is runtime-only)
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-opensearch.conf
sudo sysctl --system
# edit docker-compose.opensearch.yml: SSD path + heap
docker compose -f docker-compose.opensearch.yml up -d
curl localhost:9200/_cluster/health    # wait for "green"
```
The compose service is marked `restart: unless-stopped`, so once Docker itself starts on
boot OpenSearch comes back automatically — **provided the SSD is mounted first** (see the
reboot checklist at the bottom).

## 3. Auth + config
- **Preferred:** attach a service account to the VM with `roles/bigquery.dataViewer` +
  `roles/bigquery.readSessionUser` (the latter is required by the Storage Read API to
  create read sessions). Then ADC works with no key file — leave
  `GOOGLE_APPLICATION_CREDENTIALS` unset.
- Otherwise copy a service-account JSON and set `GOOGLE_APPLICATION_CREDENTIALS` to its path.
```
cp .env.example .env        # edit if needed (defaults target your dataset)
# fresh Debian/Ubuntu GCP images ship Python but not pip/venv — install once:
sudo apt update && sudo apt install -y python3-pip python3-venv
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```
This Python setup is needed **only to run the ingest** (initial load, or later re-loads).
Serving search at runtime does not need Python — see the reboot checklist below.

## 4. Disk / shards (read before the full run)
- The full 235M-doc index may reach ~150–250 GB; segment merges need headroom. **Watch
  disk** on the SSD — 250 GB is tight.
- `number_of_shards` is set to **5** in `opensearch_index.json` and **cannot be changed
  after the index is created**. Adjust it *before* the first run if you want a different
  layout (aim ~10–50 GB/shard).

## 5. Run
The loader uses the **BigQuery Storage Read API** (parallel Arrow read streams, no per-page
query overhead) and `parallel_bulk` (concurrent indexing). Reading and indexing overlap.
```
python scripts/ingest_opensearch.py                 # full corpus (checkpointed, resumable)
python scripts/ingest_opensearch.py --max-docs 5000 # quick smoke test first
```
Tuning (raise these to push throughput; mind instance CPU/RAM and OpenSearch heap):
```
python scripts/ingest_opensearch.py --read-streams 16 --index-threads 12 --chunk-size 5000
```
- `--read-streams` parallel read streams (server may return fewer), `--index-threads` bulk
  indexing threads, `--chunk-size` docs per bulk request.
- The loader disables `refresh_interval` during load and **always** restores it + refreshes at
  the end (even on error), so a crash never leaves the index unrefreshable.

### Checkpointing & resume (survives crashes)
`_id = corpusid` makes every write idempotent, but Storage Read streams are **unordered**, so
the load is checkpointed by **corpusid bands** instead of a cursor. The corpusid space is split
into fixed-width half-open ranges; each band is read with a server-side `row_restriction` and
recorded as done (in a small JSON checkpoint) only once fully indexed. **A crash resumes at the
first unfinished band** — completed bands are never re-read.
```
python scripts/ingest_opensearch.py                       # resumes automatically from the checkpoint
python scripts/ingest_opensearch.py --reconcile           # FIRST run on a partially-loaded index:
                                                          #   mark bands that are already fully
                                                          #   present as done, so they aren't redone
python scripts/ingest_opensearch.py --band-width 1000000  # finer checkpoint granularity (more bands)
```
- `--band-width` (default 2,000,000) — the checkpoint unit; ~118 bands for the 235M corpus.
- `--checkpoint <path>` — checkpoint file (default `scripts/.ingest_checkpoint.json`). Delete it
  to force a full re-ingest. Changing `--band-width` invalidates and resets it automatically.
- `--band-retries` (default 5) — a transient network / BigQuery / OpenSearch error retries the
  band with exponential backoff; if a band still fails, the run stops **without** marking it done
  so the next run resumes exactly there.
- `--reconcile` compares per-band BigQuery vs OpenSearch counts and pre-marks already-complete
  bands — run it once on an index that was partially loaded before checkpointing existed.
- `--resume-from <corpusid>` is a **legacy** lower bound (skips bands at/below it); the checkpoint
  supersedes it. Tip: run under `tmux`/`nohup` (or systemd) so the load survives a dropped SSH session.

## 6. Point the backend at it
On the backend host set `OPENSEARCH_URL=http://<instance-internal-ip>:9200` (and
`OPENSEARCH_INDEX=papers`). Restrict the instance's 9200 firewall to the backend only.

## Reboot checklist (steady state)
**You ingest once.** The index lives in OpenSearch's data dir on the SSD and persists across
reboots — no re-ingest, no Python needed at runtime. On every startup all that must be true
is: SSD mounted → OpenSearch up. With the steps below it's fully automatic.

1. **SSD mounts at boot** — add it to `/etc/fstab` so it's present before Docker starts.
   Get the device UUID with `sudo blkid`, then append a line like:
   ```
   UUID=<your-ssd-uuid>  /mnt/ssd  ext4  defaults,nofail  0  2
   ```
   Verify with `sudo mount -a` (no errors) before trusting it.
2. **`vm.max_map_count` persists** — done in step 2 above via `/etc/sysctl.d/99-opensearch.conf`.
3. **OpenSearch auto-starts** — `restart: unless-stopped` (already in the compose file) plus
   Docker's own service starting on boot (`sudo systemctl enable docker`) brings the container
   back with no manual command.

After a reboot, confirm with `curl localhost:9200/papers/_count` — if the count matches what
you ingested, you're done. A count of 0 almost always means the SSD didn't mount before
OpenSearch started (check `df -h /mnt/ssd` and `docker logs`).

## Verify
```
curl "localhost:9200/papers/_count"
curl -s localhost:9200/papers/_search -H 'Content-Type: application/json' -d '{
  "size":1,
  "query":{"bool":{"must":[
    {"bool":{"should":[{"match_phrase":{"title":"transformer"}},{"match_phrase":{"abstract":"transformer"}}],"minimum_should_match":1}}
  ]}}}'
```
