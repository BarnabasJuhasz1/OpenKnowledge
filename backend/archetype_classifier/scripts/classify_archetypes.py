#!/usr/bin/env python3
"""Offline vLLM classification of academic paper abstracts into contribution archetypes.

Designed for ~1M abstracts on a single 64GB GPU. Input is streamed from disk in
chunks so host RAM stays bounded, and results are flushed to a JSONL file after
every chunk. The long, constant system prompt is the shared token prefix across
every request, so Automatic Prefix Caching reuses its KV cache on every call.

Note: the schema-guided output is one JSON object per paper (one request per
paper). The system prompt's "JSON list" wording is kept verbatim as required by
the spec, but the structured-output schema governs the actual per-request format.
"""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

# --- THE HPC SYNC BYPASS ---
# The cluster storage hasn't synced the pyairports/pycountry source files yet.
# Since our JSON schema doesn't use them, we trick the 'outlines' parser 
# by injecting fake dummy modules into memory before importing vLLM.
sys.modules['pyairports'] = MagicMock()
sys.modules['pyairports.airports'] = MagicMock()
sys.modules['pycountry'] = MagicMock()

import os

import pyairports  # <-- Forces the module into memory early
import pycountry   # <-- Forces the module into memory early

import argparse
import json
import logging
from pathlib import Path
from typing import Iterator, Optional

# --- CRITICAL OFFLINE SETTINGS ---
# These environment variables strictly prevent the underlying Hugging Face 
# libraries (used by vLLM for tokenization/configs) from attempting network calls.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"
os.environ["HF_TOKEN"] = "offline_dummy_token"
os.environ["HF_HOME"] = os.path.expandvars("$FAST/hf_cache_$USER")
os.environ["OUTLINES_CACHE_DIR"] = os.path.expandvars("$FAST/outlines_cache_$USER")

from pydantic import BaseModel
from vllm import LLM, SamplingParams
from vllm.sampling_params import GuidedDecodingParams

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("archetype_classifier")

# Kept verbatim per the task spec. This is the constant prefix that the engine's
# prefix cache reuses across every request.
SYSTEM_PROMPT = """Act as an expert academic meta-researcher and taxonomist. Classify academic research papers based on their contribution archetype.

Level 1: Universal Parent Categories

The Innovator: Introduces a fundamentally novel methodology, theory, or theoretical framework to the field.

The Synthesizer: Aggregates, structures, and builds a comprehensive taxonomy out of existing literature.

The Combiner: Fuses two or more distinct, existing methodologies into a single hybrid approach.

The Architect: Chains existing methods together into a novel sequential end-to-end processing pipeline.

The Translator: Takes a method established in one domain and adapts it to solve a problem in an entirely different domain.

The Evaluator: Runs rigorous comparative tests on existing methods under identical conditions to establish benchmarks.

The Analyst: Reverse-engineers or mathematically analyzes existing phenomena or methods to explain why they work or fail.

The Resource Creator: Produces foundational artifacts, datasets, or tooling that enable further research by the community.

Level 2: Domain-Specific Sub-Categories (Computer Science & AI)

The Innovator (Algorithm/Architecture)

The Innovator (Theoretical Proof)

The Resource Creator (Dataset/Corpus)

The Resource Creator (Software/Library)

The Evaluator (Algorithmic Benchmark)

I will provide a batch of papers. Classify each paper into one of these archetypes. If a Level 2 sub-category perfectly fits, use it. If not, leave the second tier empty.
You MUST return a JSON list containing ONLY the exact 'row_index', 'main_archetype', and 'second_tier_archetype'. Do not generate any reasoning or extra text."""


class Classification(BaseModel):
    """Structured output schema enforced via guided JSON decoding."""

    row_index: int
    main_archetype: str
    second_tier_archetype: Optional[str] = None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", default="/leonardo/home/userexternal/bjuhasz0/fast_hyco/barnabas/data/clean_mock_papers.csv", help="Input .parquet or .jsonl file of abstracts.")
    p.add_argument("--output", default="/leonardo/home/userexternal/bjuhasz0/fast_hyco/barnabas/data/clean_mock_papers_archetypes.csv",help="Output .jsonl path (overwritten on start).")
    p.add_argument("--model", default="/leonardo/home/userexternal/bjuhasz0/fast_hyco/barnabas/model/qwen-14b-instruct")
    p.add_argument("--text-column", default="abstract", help="Column/field holding the abstract text.")
    p.add_argument(
        "--id-column",
        default=None,
        help="Optional column/field for row_index. Defaults to the 0-based file order.",
    )
    p.add_argument("--chunk-size", type=int, default=1_000)
    p.add_argument("--max-model-len", type=int, default=4096)
    p.add_argument("--gpu-memory-utilization", type=float, default=0.95)
    p.add_argument("--max-tokens", type=int, default=256, help="Max generated tokens per paper.")
    p.add_argument("--limit", type=int, default=None, help="Process at most this many rows (smoke test).")
    return p.parse_args()

import csv

def iter_csv_chunks(
    path: Path, chunk_size: int, text_column: str, id_column: Optional[str]
) -> Iterator[list[tuple[int, str]]]:
    chunk: list[tuple[int, str]] = []
    running = 0
    with path.open(newline='', encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            row_index = int(row[id_column]) if id_column and id_column in row else running
            running += 1
            abstract = row.get(text_column, "")
            chunk.append((row_index, str(abstract)))
            if len(chunk) >= chunk_size:
                yield chunk
                chunk = []
    if chunk:
        yield chunk

def iter_jsonl_chunks(
    path: Path, chunk_size: int, text_column: str, id_column: Optional[str]
) -> Iterator[list[tuple[int, str]]]:
    chunk: list[tuple[int, str]] = []
    running = 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            row_index = int(obj[id_column]) if id_column else running
            running += 1
            abstract = obj.get(text_column) if isinstance(obj, dict) else None
            chunk.append((row_index, "" if abstract is None else str(abstract)))
            if len(chunk) >= chunk_size:
                yield chunk
                chunk = []
    if chunk:
        yield chunk


def iter_parquet_chunks(
    path: Path, chunk_size: int, text_column: str, id_column: Optional[str]
) -> Iterator[list[tuple[int, str]]]:
    import pyarrow.parquet as pq

    columns = [text_column] + ([id_column] if id_column else [])
    pf = pq.ParquetFile(path)
    running = 0
    for batch in pf.iter_batches(batch_size=chunk_size, columns=columns):
        data = batch.to_pydict()
        texts = data[text_column]
        ids = data[id_column] if id_column else None
        chunk: list[tuple[int, str]] = []
        for i, abstract in enumerate(texts):
            row_index = int(ids[i]) if ids is not None else running
            running += 1
            chunk.append((row_index, "" if abstract is None else str(abstract)))
        yield chunk


def iter_chunks(
    path: Path, chunk_size: int, text_column: str, id_column: Optional[str]
) -> Iterator[list[tuple[int, str]]]:
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        yield from iter_parquet_chunks(path, chunk_size, text_column, id_column)
    elif suffix in (".jsonl", ".json", ".ndjson"):
        yield from iter_jsonl_chunks(path, chunk_size, text_column, id_column)
    elif suffix == ".csv":
        yield from iter_csv_chunks(path, chunk_size, text_column, id_column)
    else:
        raise ValueError(f"Unsupported input extension '{suffix}'. Use .parquet or .jsonl.")


def build_prompt(tokenizer, row_index: int, abstract: str) -> str:
    """Render the chat template with the constant system prompt first, abstract last."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Row index: {row_index}\n\nAbstract:\n{abstract}"},
    ]
    return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def parse_output(text: str, row_index: int) -> dict:
    """Validate a generated object against the schema; trust our own row_index."""
    try:
        result = Classification.model_validate_json(text)
        # The model echoes a row_index, but the authoritative value is the one we
        # assigned from the input, so overwrite it to guarantee correct alignment.
        result.row_index = row_index
        return result.model_dump()
    except Exception as exc:  # boundary: LLM text is untrusted, never crash a 1M-row run
        logger.warning("Unparseable output for row %d: %s", row_index, exc)
        return {
            "row_index": row_index,
            "main_archetype": None,
            "second_tier_archetype": None,
            "parse_error": str(exc),
        }


def main() -> None:
    print(">>> Starting script...")
    args = parse_args()
    print(f">>> Initializing vLLM from {args.model} (This can take 2-5 minutes...)")
    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # --- RESUME LOGIC: Find first empty primary classification ---
    processed_count = 0
    if output_path.exists():
        valid_records = []
        first_empty_idx = None
        with output_path.open("r", encoding="utf-8") as f:
            for idx, line in enumerate(f):
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    record = json.loads(line_str)
                    main_arch = record.get("main_archetype")
                    # Check if main_archetype is null, empty string, or missing
                    is_empty = (main_arch is None) or (isinstance(main_arch, str) and not main_arch.strip())
                except Exception:
                    is_empty = True
                
                if is_empty and first_empty_idx is None:
                    first_empty_idx = idx
                
                if first_empty_idx is None:
                    valid_records.append(line)
        
        if first_empty_idx is not None:
            processed_count = first_empty_idx
            print(f">>> Found first empty primary classification at line {first_empty_idx + 1}. Resuming from here and truncating output file...")
            # Rewrite output file to keep only valid classifications before the first empty one
            with output_path.open("w", encoding="utf-8") as f:
                f.writelines(valid_records)
        else:
            processed_count = len(valid_records)
            print(f">>> Found {processed_count} existing records, all with valid primary classifications. Resuming from here...")

    llm = LLM(
        model=args.model,
        gpu_memory_utilization=args.gpu_memory_utilization,
        max_model_len=args.max_model_len,
        enable_prefix_caching=True,
    )
    print(">>> vLLM initialized successfully!")
    tokenizer = llm.get_tokenizer()

    sampling_params = SamplingParams(
        temperature=0.0,
        max_tokens=args.max_tokens,
        guided_decoding=GuidedDecodingParams(json=Classification.model_json_schema()),
    )

    total = processed_count
    skipped = 0

    # --- CHANGED: Open file in append ("a") mode ---
    with output_path.open("a", encoding="utf-8") as out_f:
        for chunk in iter_chunks(input_path, args.chunk_size, args.text_column, args.id_column):
            
            # --- SKIP LOGIC: Fast-forward through already processed chunks ---
            if skipped < processed_count:
                if skipped + len(chunk) <= processed_count:
                    # Entire chunk is already processed
                    skipped += len(chunk)
                    continue
                else:
                    # Partial chunk overlap (happens if the script crashed mid-chunk)
                    overlap = processed_count - skipped
                    chunk = chunk[overlap:]
                    skipped += overlap

            # Apply limit if testing (processes up to 'limit' NEW rows)
            if args.limit is not None and (total - processed_count) >= args.limit:
                break
            if args.limit is not None:
                chunk = chunk[: args.limit - (total - processed_count)]

            prompts = [build_prompt(tokenizer, row_index, abstract) for row_index, abstract in chunk]
            outputs = llm.generate(prompts, sampling_params)

            for (row_index, _), output in zip(chunk, outputs):
                record = parse_output(output.outputs[0].text, row_index)
                out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
            out_f.flush()  # persist this chunk before the next one is read into RAM

            total += len(chunk)
            logger.info("Processed %d rows overall (-> %s)", total, output_path)

    logger.info("Done. Total records in file: %d", total)

if __name__ == "__main__":
    main()
