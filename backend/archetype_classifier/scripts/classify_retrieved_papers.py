#!/usr/bin/env python3
"""Real-time archetype inference for papers retrieved by the OpenKnowledge backend.

Unlike ``classify_all_papers.py`` (bulk CSV → CSV), this script is built to be
driven by the backend. It exposes two modes:

  * ``serve``  — a persistent worker. Loads the model once, prints a single
                 ``{"event": "ready"}`` line on stdout, then reads newline-delimited
                 JSON requests on stdin and writes one JSON response line per
                 request on stdout. ALL diagnostics go to stderr so stdout stays a
                 clean protocol channel.
  * ``batch``  — one-shot ``--input in.json --output out.json`` for CLI testing.

The checkpoint (``checkpoint-6402``) ships without a ``config.json`` and the base
SciBERT weights are not available locally, but the checkpoint's ``model.safetensors``
contains the *full* model (encoder + classification heads). So we rebuild the BERT
encoder architecture from a static config dict in the config file and load the
checkpoint weights over it — entirely offline, no SciBERT download.

Request line:  {"id": <int>, "items": [{"id": "<str>", "abstract": "<str>"}, ...]}
Response line: {"id": <int>, "results": [{"id": "<str>",
                   "primary": "<label|null>", "secondary": "<label|null>",
                   "main_confidence": <float>, "second_confidence": <float>}, ...]}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Force Hugging Face fully offline — we never need the hub.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def log(*args) -> None:
    """Diagnostics to stderr only — stdout is the protocol channel."""
    print(*args, file=sys.stderr, flush=True)


def _load_json(path: str | Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class ArchetypeModel:
    """Loads the multi-task classifier from a checkpoint + static encoder config."""

    def __init__(self, cfg: dict) -> None:
        import torch
        from transformers import AutoConfig, AutoModel, AutoTokenizer
        from safetensors.torch import load_file

        # Import the model definition that lives next to this script.
        sys.path.append(str(Path(__file__).resolve().parent))
        from model import MultiTaskClassifier

        self._torch = torch

        checkpoint_dir = Path(cfg["checkpoint_dir"])
        mapping = _load_json(cfg["label_mapping_path"])
        self.id2primary = mapping["primary"]
        self.id2secondary = mapping["secondary"]

        encoder_config = cfg["encoder_config"]
        log(f"[archetype] building encoder from config (offline) …")
        auto_cfg = AutoConfig.for_model(**encoder_config)
        encoder = AutoModel.from_config(auto_cfg)

        model = MultiTaskClassifier(
            encoder,
            num_primary=len(self.id2primary),
            num_secondary=len(self.id2secondary),
            id2label_primary=self.id2primary,
            id2label_secondary=self.id2secondary,
        )

        weights_path = checkpoint_dir / "model.safetensors"
        log(f"[archetype] loading weights from {weights_path} …")
        state = load_file(str(weights_path))
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing:
            log(f"[archetype] WARNING missing keys: {len(missing)} (e.g. {missing[:3]})")
        if unexpected:
            log(f"[archetype] WARNING unexpected keys: {len(unexpected)} (e.g. {unexpected[:3]})")

        device = cfg.get("device", "auto")
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        model.to(device)
        model.eval()
        self.model = model

        self.tokenizer = AutoTokenizer.from_pretrained(str(checkpoint_dir))
        self.batch_size = int(cfg.get("batch_size", 64))
        self.max_length = int(cfg.get("max_length", 512))
        log(f"[archetype] model ready on {device} (batch_size={self.batch_size}).")

    @staticmethod
    def _map(mapping: dict, idx: int) -> str:
        for key in (idx, str(idx), int(idx)):
            if key in mapping:
                return mapping[key]
        return "Unknown"

    def classify(self, texts: list[str]) -> list[tuple[str, str, float, float]]:
        """Return (primary, secondary, primary_conf, secondary_conf) per text."""
        torch = self._torch
        out: list[tuple[str, str, float, float]] = []
        with torch.no_grad():
            for i in range(0, len(texts), self.batch_size):
                batch = texts[i : i + self.batch_size]
                inputs = self.tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=self.max_length,
                    return_tensors="pt",
                )
                inputs = {k: v.to(self.device) for k, v in inputs.items()}
                result = self.model(**inputs)
                logits_p, logits_s = result["logits"]
                probs_p = torch.softmax(logits_p, dim=-1)
                probs_s = torch.softmax(logits_s, dim=-1)
                conf_p, pred_p = torch.max(probs_p, dim=-1)
                conf_s, pred_s = torch.max(probs_s, dim=-1)
                for j in range(len(batch)):
                    out.append(
                        (
                            self._map(self.id2primary, int(pred_p[j])),
                            self._map(self.id2secondary, int(pred_s[j])),
                            float(conf_p[j]),
                            float(conf_s[j]),
                        )
                    )
        return out


def _classify_items(model: ArchetypeModel, items: list[dict]) -> list[dict]:
    """Classify a request's items, skipping the model for blank abstracts."""
    indices: list[int] = []
    texts: list[str] = []
    for idx, item in enumerate(items):
        abstract = (item.get("abstract") or "").strip()
        if abstract:
            indices.append(idx)
            texts.append(abstract)

    predictions = model.classify(texts) if texts else []

    results = [
        {
            "id": item.get("id"),
            "primary": None,
            "secondary": None,
            "main_confidence": 0.0,
            "second_confidence": 0.0,
        }
        for item in items
    ]
    for slot, (primary, secondary, cp, cs) in zip(indices, predictions):
        results[slot].update(
            primary=primary,
            secondary=secondary,
            main_confidence=cp,
            second_confidence=cs,
        )
    return results


def run_serve(cfg: dict) -> int:
    model = ArchetypeModel(cfg)
    # Signal readiness on the protocol channel.
    sys.stdout.write(json.dumps({"event": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            req_id = request.get("id")
            items = request.get("items") or []
            results = _classify_items(model, items)
            response = {"id": req_id, "results": results}
        except Exception as e:  # noqa: BLE001 — never let one bad request kill the worker
            log(f"[archetype] request error: {e}")
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "error": str(e), "results": []}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
    return 0


def run_batch(cfg: dict, input_path: str, output_path: str) -> int:
    payload = _load_json(input_path)
    items = payload.get("items") if isinstance(payload, dict) else payload
    model = ArchetypeModel(cfg)
    results = _classify_items(model, items or [])
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"results": results}, f, indent=2)
    log(f"[archetype] wrote {len(results)} results to {output_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Real-time archetype inference worker.")
    parser.add_argument("mode", choices=["serve", "batch"], help="Run mode.")
    parser.add_argument("--config", required=True, help="Path to the JSON config file.")
    parser.add_argument("--input", help="(batch) Input JSON file.")
    parser.add_argument("--output", help="(batch) Output JSON file.")
    return parser.parse_args()


def resolve_path(path_str: str) -> str:
    path_val = Path(path_str)
    if path_val.is_absolute():
        return str(path_val)
    current = Path(__file__).resolve().parent
    candidates = []
    for _ in range(6):
        candidates.append(current)
        if current.parent == current:
            break
        current = current.parent
    for base in candidates:
        candidate_path = (base / path_val).resolve()
        if candidate_path.exists():
            return str(candidate_path)
    return str(path_val.resolve())


def main() -> int:
    args = parse_args()
    cfg = _load_json(args.config)
    
    # Resolve relative paths in config dynamically
    for key in ["script_path", "checkpoint_dir", "label_mapping_path"]:
        if key in cfg and cfg[key]:
            cfg[key] = resolve_path(cfg[key])
            
    if args.mode == "serve":
        return run_serve(cfg)
    if not args.input or not args.output:
        log("batch mode requires --input and --output")
        return 2
    return run_batch(cfg, args.input, args.output)


if __name__ == "__main__":
    sys.exit(main())
