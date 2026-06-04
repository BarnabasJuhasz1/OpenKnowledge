#!/usr/bin/env python3
"""Run bulk multi-task batch inference on the entire papers dataset.

Loads a fine-tuned MultiTaskClassifier checkpoint and processes clean_mock_papers.csv
chunk-by-chunk to append 'predicted_main_archetype' and 'predicted_second_tier_archetype'
columns, writing results directly to a new classified CSV file.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

# Force Hugging Face offline mode
os.environ["HF_HOME"] = str(Path.cwd() / ".hf_cache")
os.environ["TRANSFORMERS_CACHE"] = str(Path.cwd() / ".hf_cache")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"

import pandas as pd
import torch
from tqdm import tqdm
from transformers import AutoTokenizer

# Add local directory to path for importing model definition
sys.path.append(str(Path(__file__).resolve().parent))
from model import MultiTaskClassifier


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run bulk multi-task sequence classification on the entire papers dataset."
    )
    parser.add_argument(
        "--checkpoint-dir",
        type=str,
        default="./fast_archetype_model",
        help="Path to the fine-tuned model checkpoint directory (defaults to ./fast_archetype_model).",
    )
    parser.add_argument(
        "--input-file",
        type=str,
        default="data/clean_mock_papers.csv",
        help="Path to the input papers CSV file (defaults to data/clean_mock_papers.csv).",
    )
    parser.add_argument(
        "--output-file",
        type=str,
        default="data/clean_mock_papers_classified.csv",
        help="Path to save the output classified CSV file (defaults to data/clean_mock_papers_classified.csv).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=256,
        help="Inference batch size (defaults to 256).",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=20000,
        help="CSV chunk size for streaming from disk (defaults to 20000).",
    )
    parser.add_argument(
        "--text-column",
        type=str,
        default="abstract",
        help="Name of the text column to classify (defaults to 'abstract').",
    )
    parser.add_argument(
        "--model-name",
        type=str,
        default="./model/scibert_scivocab_uncased",
        help="Path or name of the base model (defaults to ./model/scibert_scivocab_uncased).",
    )
    return parser.parse_args()


def find_resume_info(output_file: Path, primary_col: str) -> tuple[int, list[list[str]]]:
    """Scan the output CSV file and return the number of valid rows before the first empty primary classification, and the list of rows to keep."""
    if not output_file.is_file():
        return 0, []
    
    first_empty_idx = None
    
    try:
        with open(output_file, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if not header:
                return 0, []
            
            if primary_col not in header:
                print(f"Warning: Primary classification column '{primary_col}' not found in output file header. Starting from scratch.", file=sys.stderr)
                return 0, []
            
            primary_col_idx = header.index(primary_col)
            valid_rows = [header]
            
            for idx, row in enumerate(reader):
                if not row:
                    continue
                # Check if primary classification is empty
                val = row[primary_col_idx] if primary_col_idx < len(row) else ""
                is_empty = (not val.strip()) or (val.lower() in ("none", "null", "nan"))
                
                if is_empty and first_empty_idx is None:
                    first_empty_idx = idx
                
                if first_empty_idx is None:
                    valid_rows.append(row)
            
            if first_empty_idx is not None:
                return first_empty_idx, valid_rows
            else:
                return len(valid_rows) - 1, valid_rows
    except Exception as e:
        print(f"Warning: Error reading output file: {e}. Starting from scratch.", file=sys.stderr)
        return 0, []


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
    args.checkpoint_dir = resolve_path(args.checkpoint_dir)

    input_path = Path(args.input_file)
    if not input_path.is_file():
        print(f"Error: Input file not found: {args.input_file}", file=sys.stderr)
        return 1

    checkpoint_path = Path(args.checkpoint_dir)
    if not checkpoint_path.is_dir():
        print(f"Error: Checkpoint directory not found: {args.checkpoint_dir}", file=sys.stderr)
        return 1

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    # Load model and tokenizer
    print(f"Loading model and tokenizer from {args.checkpoint_dir}...")
    try:
        model = MultiTaskClassifier.from_pretrained(args.checkpoint_dir, model_name=args.model_name)
        tokenizer = AutoTokenizer.from_pretrained(args.checkpoint_dir)
    except Exception as e:
        print(f"Error loading model: {e}", file=sys.stderr)
        return 1

    model.to(device)
    model.eval()

    # Determine total lines for progress bar (fast estimate or word count)
    print("Estimating total rows for progress tracking...")
    try:
        # Simple fast line counter for large files
        with open(input_path, "rb") as f:
            total_rows = sum(1 for _ in f) - 1 # Subtract 1 for header
    except Exception:
        total_rows = None

    print(f"Starting bulk classification. Writing outputs to {args.output_file}...")
    
    output_path = Path(args.output_file)
    # Ensure parent output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # --- RESUME LOGIC: Find first empty primary classification ---
    processed_count, valid_rows = find_resume_info(output_path, "predicted_main_archetype")
    if processed_count > 0:
        print(f">>> Found {processed_count} existing classified records. Resuming from here and truncating output file...")
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerows(valid_rows)
    else:
        if output_path.exists():
            os.remove(output_path)

    first_chunk = (processed_count == 0)
    skipped = 0
    progress_bar = tqdm(total=total_rows, desc="Classifying papers", unit="row")
    if processed_count > 0:
        progress_bar.update(processed_count)

    # Read the input CSV chunk by chunk
    chunks = pd.read_csv(args.input_file, chunksize=args.chunk_size)
    for chunk in chunks:
        # Skip logic
        if skipped < processed_count:
            if skipped + len(chunk) <= processed_count:
                skipped += len(chunk)
                continue
            else:
                overlap = processed_count - skipped
                chunk = chunk.iloc[overlap:]
                skipped += overlap

        # Verify text column exists
        if args.text_column not in chunk.columns:
            print(f"\nError: Text column '{args.text_column}' not found in input CSV.", file=sys.stderr)
            return 1

        texts = chunk[args.text_column].fillna("").tolist()
        primary_preds = []
        secondary_preds = []

        # Process chunk in model batches
        for i in range(0, len(texts), args.batch_size):
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

            preds_p = torch.argmax(logits_primary, dim=-1)
            preds_s = torch.argmax(logits_secondary, dim=-1)

            primary_preds.extend([
                map_id_to_label(model.id2label_primary, idx)
                for idx in preds_p.cpu().numpy()
            ])
            secondary_preds.extend([
                map_id_to_label(model.id2label_secondary, idx)
                for idx in preds_s.cpu().numpy()
            ])

        # Add the classifications to the chunk
        chunk["predicted_main_archetype"] = primary_preds
        chunk["predicted_second_tier_archetype"] = secondary_preds

        # Save to output file
        chunk.to_csv(args.output_file, mode="a", index=False, header=first_chunk)
        first_chunk = False
        
        progress_bar.update(len(chunk))

    progress_bar.close()
    print("Success! Bulk classification completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
