#!/usr/bin/env python3
"""Run fast batch inference using the fine-tuned MultiTaskClassifier model.

Predicts both primary (main_archetype) and secondary (second_tier_archetype)
archetypes for unlabeled papers and saves predictions and confidence scores.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ["HF_HOME"] = str(Path.cwd() / ".hf_cache")
os.environ["TRANSFORMERS_CACHE"] = str(Path.cwd() / ".hf_cache")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"

import pandas as pd
import torch
from tqdm import tqdm
from transformers import AutoTokenizer

# Add local directory to path for import
sys.path.append(str(Path(__file__).resolve().parent))
from model import MultiTaskClassifier


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run fast multi-task archetype inference."
    )
    parser.add_argument(
        "--model-dir",
        type=str,
        default="./fast_archetype_model",
        help="Path to the fine-tuned model directory (defaults to ./fast_archetype_model).",
    )
    parser.add_argument(
        "--input",
        type=str,
        default="remaining_abstracts.parquet",
        help="Path to the unlabeled papers file (.parquet, .csv, or .jsonl).",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="fully_classified_abstracts.parquet",
        help="Path to save the output classified papers.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=128,
        help="Batch size for inference.",
    )
    return parser.parse_args()


def map_id_to_label(mapping: dict, idx: int) -> str:
    if idx in mapping:
        return mapping[idx]
    if str(idx) in mapping:
        return mapping[str(idx)]
    if int(idx) in mapping:
        return mapping[int(idx)]
    return "Unknown"


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


@torch.no_grad()
def main() -> int:
    args = parse_args()
    args.model_dir = resolve_path(args.model_dir)
    
    # Load input data
    input_path = Path(args.input)
    if not input_path.is_file():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        return 1

    print(f"Loading unlabeled data from {args.input}...")
    if args.input.endswith(".parquet"):
        df = pd.read_parquet(args.input)
    elif args.input.endswith(".csv"):
        df = pd.read_csv(args.input)
    else:
        df = pd.read_json(args.input, lines=True)

    if "abstract" not in df.columns:
        print("Error: Input file must contain an 'abstract' column.", file=sys.stderr)
        return 1

    texts = df["abstract"].fillna("").tolist()

    # Determine device
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    # Load model and tokenizer
    print(f"Loading model and tokenizer from {args.model_dir}...")
    try:
        model = MultiTaskClassifier.from_pretrained(args.model_dir)
        tokenizer = AutoTokenizer.from_pretrained(args.model_dir)
    except Exception as e:
        print(f"Error loading model: {e}", file=sys.stderr)
        return 1

    model.to(device)
    model.eval()

    primary_preds = []
    secondary_preds = []
    primary_scores = []
    secondary_scores = []

    print(f"Classifying {len(texts)} abstracts...")
    for i in tqdm(range(0, len(texts), args.batch_size)):
        batch_texts = texts[i : i + args.batch_size]
        inputs = tokenizer(
            batch_texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="pt"
        )
        inputs = {k: v.to(device) for k, v in inputs.items()}

        outputs = model(**inputs)
        logits_primary, logits_secondary = outputs["logits"]

        probs_primary = torch.softmax(logits_primary, dim=-1)
        probs_secondary = torch.softmax(logits_secondary, dim=-1)

        scores_primary, preds_p = torch.max(probs_primary, dim=-1)
        scores_secondary, preds_s = torch.max(probs_secondary, dim=-1)

        primary_preds.extend([
            map_id_to_label(model.id2label_primary, idx)
            for idx in preds_p.cpu().numpy()
        ])
        secondary_preds.extend([
            map_id_to_label(model.id2label_secondary, idx)
            for idx in preds_s.cpu().numpy()
        ])
        
        primary_scores.extend(scores_primary.cpu().numpy().tolist())
        secondary_scores.extend(scores_secondary.cpu().numpy().tolist())

    df["predicted_main_archetype"] = primary_preds
    df["predicted_second_tier_archetype"] = secondary_preds
    df["main_archetype_confidence"] = primary_scores
    df["second_tier_archetype_confidence"] = secondary_scores

    print(f"Saving classified results to {args.output}...")
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    if args.output.endswith(".parquet"):
        df.to_parquet(args.output)
    elif args.output.endswith(".csv"):
        df.to_csv(args.output, index=False)
    else:
        df.to_json(args.output, orient="records", lines=True)

    print("Success! Inference complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())