#!/usr/bin/env python3
"""Trains a fast, small Transformer (e.g., SciBERT or DistilRoBERTa) on paper abstracts
to predict both primary (main_archetype) and secondary (second_tier_archetype) contribution archetypes.

Supports loading the merged CSV file directly or loading and merging separate data and labels.
Logs metrics to Weights & Biases (wandb).

Usage:
    python train_fast_classifier.py --data data/clean_mock_papers_archetypes_with_abstracts.csv --wandb-project fast-archetype-classifier
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

# Fix cache directory issue on the cluster before importing transformers
os.environ["HF_HOME"] = str(Path.cwd() / ".hf_cache")
os.environ["TRANSFORMERS_CACHE"] = str(Path.cwd() / ".hf_cache")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_DATASETS_OFFLINE"] = "1"

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from datasets import Dataset
import wandb
import torch
from transformers import (
    AutoTokenizer,
    AutoModel,
    TrainingArguments,
    Trainer,
    DataCollatorWithPadding
)
from sklearn.metrics import accuracy_score, f1_score

# Add the local directory to system path to import model definitions
sys.path.append(str(Path(__file__).resolve().parent))
from model import MultiTaskClassifier

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("fast_classifier")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--data",
        required=True,
        help="Input data file (e.g., merged CSV or original abstracts.parquet/.jsonl)",
    )
    p.add_argument(
        "--labels",
        required=False,
        default=None,
        help="Optional separate labels JSONL file from vLLM. If omitted, --data must contain labels.",
    )
    p.add_argument(
        "--text-column",
        default="abstract",
        help="Column name containing the text",
    )
    p.add_argument(
        "--id-column",
        default=None,
        help="Column name for row IDs (if used in vLLM script)",
    )
    p.add_argument(
        "--model-name",
        default="allenai/scibert_scivocab_uncased",
        help="Base model. Alternatives: 'distilroberta-base' for speed.",
    )
    p.add_argument(
        "--output-dir",
        default="./fast_archetype_model",
        help="Where to save the model",
    )
    p.add_argument(
        "--wandb-project",
        default="fast-archetype-classifier",
        help="W&B project name",
    )
    p.add_argument(
        "--resume-from-checkpoint",
        default=None,
        help="Path to a checkpoint folder to resume training from, or 'True' to auto-detect the latest checkpoint in output_dir.",
    )
    p.add_argument(
        "--epochs",
        type=int,
        default=5,
        help="Number of epochs to train (defaults to 3).",
    )
    p.add_argument(
        "--learning-rate",
        type=float,
        default=2e-5,
        help="Learning rate (defaults to 2e-5).",
    )
    return p.parse_args()


def load_and_prepare_data(args: argparse.Namespace) -> pd.DataFrame:
    logger.info(f"Loading data from {args.data}...")
    
    # Load input data file
    if args.data.endswith(".parquet"):
        df = pd.read_parquet(args.data)
    elif args.data.endswith(".csv"):
        df = pd.read_csv(args.data)
    else:
        df = pd.read_json(args.data, lines=True)
    
    # Load and merge labels if separate file is provided
    if args.labels:
        logger.info(f"Loading separate labels from {args.labels}...")
        labels = []
        with open(args.labels, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    labels.append(json.loads(line))
        df_labels = pd.DataFrame(labels)
        
        # Determine row_index for merging
        if args.id_column and args.id_column in df.columns:
            df["row_index"] = df[args.id_column].astype(int)
        else:
            df["row_index"] = range(len(df))
            
        df_labels = df_labels.dropna(subset=["main_archetype"])
        logger.info("Merging texts and labels...")
        df = pd.merge(df[["row_index", args.text_column]], df_labels, on="row_index", how="inner")
    else:
        # Check if the labels columns exist in the loaded data
        if "main_archetype" not in df.columns:
            raise ValueError(
                "Error: --labels is not provided, and the input data does not contain 'main_archetype'."
            )
        df = df.dropna(subset=["main_archetype"])

    # Clean classes
    df["main_archetype"] = df["main_archetype"].astype(str).str.strip()
    df["second_tier_archetype"] = (
        df["second_tier_archetype"].fillna("None").astype(str).str.strip()
    )
    df.loc[df["second_tier_archetype"] == "", "second_tier_archetype"] = "None"
    
    logger.info(f"Successfully prepared {len(df)} labeled examples.")
    return df


def main() -> int:
    args = parse_args()
    
    # Initialize wandb
    wandb.init(project=args.wandb_project, config=vars(args))
    
    # Load data
    df = load_and_prepare_data(args)
    
    # 1. Encode both labels to integers
    le_primary = LabelEncoder()
    df["primary_label"] = le_primary.fit_transform(df["main_archetype"])
    
    le_secondary = LabelEncoder()
    df["secondary_label"] = le_secondary.fit_transform(df["second_tier_archetype"])
    
    # Combine into a single list of targets for multi-task
    df["labels"] = df.apply(lambda r: [r["primary_label"], r["secondary_label"]], axis=1)
    
    id2label_primary = {int(i): label for i, label in enumerate(le_primary.classes_)}
    id2label_secondary = {int(i): label for i, label in enumerate(le_secondary.classes_)}
    
    # Save the label mappings for inference
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    with open(Path(args.output_dir) / "label_mapping.json", "w") as f:
        json.dump({
            "primary": id2label_primary,
            "secondary": id2label_secondary
        }, f, indent=2)

    # 2. Train / Validation Split (90/10)
    # Stratify on a composite key to ensure balanced splits for both tasks
    df["composite_stratify"] = df["main_archetype"] + "__" + df["second_tier_archetype"]
    
    # In case there are extremely rare composite classes (size 1), fallback to stratifying only on primary.
    # If primary label also has rare classes, fallback to non-stratified split.
    try:
        train_df, val_df = train_test_split(
            df, test_size=0.1, random_state=42, stratify=df["composite_stratify"]
        )
    except ValueError:
        logger.warning("Stratification on composite labels failed. Trying stratification on primary label...")
        try:
            train_df, val_df = train_test_split(
                df, test_size=0.1, random_state=42, stratify=df["primary_label"]
            )
        except ValueError:
            logger.warning("Stratification on primary label failed. Falling back to non-stratified split.")
            train_df, val_df = train_test_split(
                df, test_size=0.1, random_state=42
            )
    
    train_dataset = Dataset.from_pandas(train_df)
    val_dataset = Dataset.from_pandas(val_df)

    # 3. Tokenization
    logger.info(f"Loading tokenizer for {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name)

    def tokenize_function(examples):
        return tokenizer(
            examples[args.text_column], truncation=True, padding=False, max_length=512
        )

    train_dataset = train_dataset.map(tokenize_function, batched=True)
    val_dataset = val_dataset.map(tokenize_function, batched=True)

    # 4. Model setup
    logger.info("Loading base transformer encoder...")
    encoder = AutoModel.from_pretrained(args.model_name)
    
    model = MultiTaskClassifier(
        encoder=encoder,
        num_primary=len(le_primary.classes_),
        num_secondary=len(le_secondary.classes_),
        id2label_primary=id2label_primary,
        id2label_secondary=id2label_secondary
    )

    # 5. Metrics setup
    def compute_metrics(eval_pred):
        predictions = eval_pred.predictions
        # Standardize format (logits can be list of numpy arrays)
        if isinstance(predictions, (tuple, list)):
            logits_primary, logits_secondary = predictions[0], predictions[1]
        else:
            # Fallback if predictions are packed in a single array
            logits_primary, logits_secondary = predictions
            
        preds_primary = np.argmax(logits_primary, axis=-1)
        preds_secondary = np.argmax(logits_secondary, axis=-1)
        
        labels_primary = eval_pred.label_ids[:, 0]
        labels_secondary = eval_pred.label_ids[:, 1]
        
        acc_primary = accuracy_score(y_true=labels_primary, y_pred=preds_primary)
        acc_secondary = accuracy_score(y_true=labels_secondary, y_pred=preds_secondary)
        
        f1_primary = f1_score(y_true=labels_primary, y_pred=preds_primary, average="weighted")
        f1_secondary = f1_score(y_true=labels_secondary, y_pred=preds_secondary, average="weighted")
        
        return {
            "primary_accuracy": acc_primary,
            "primary_f1": f1_primary,
            "secondary_accuracy": acc_secondary,
            "secondary_f1": f1_secondary,
            "accuracy": 0.5 * (acc_primary + acc_secondary),
            "f1": 0.5 * (f1_primary + f1_secondary),
        }

    # 6. Training Arguments
    # Disable fp16 on CPU as it causes errors
    use_fp16 = torch.cuda.is_available()
    
    training_args = TrainingArguments(
        output_dir=args.output_dir,
        learning_rate=args.learning_rate,
        per_device_train_batch_size=16,
        per_device_eval_batch_size=32,
        num_train_epochs=args.epochs,
        weight_decay=0.01,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        fp16=use_fp16,
        report_to="wandb",
        logging_steps=10,
        run_name=args.wandb_project,
    )

    data_collator = DataCollatorWithPadding(tokenizer=tokenizer)

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        tokenizer=tokenizer,
        data_collator=data_collator,
        compute_metrics=compute_metrics,
    )

    # 7. Train!
    logger.info("Starting training...")
    resume = args.resume_from_checkpoint
    if resume == "True" or resume == "true":
        resume = True
    elif resume == "False" or resume == "false":
        resume = False
    
    trainer.train(resume_from_checkpoint=resume)

    # 8. Save the final best model
    logger.info(f"Saving final model to {args.output_dir}")
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    # Close W&B logging
    wandb.finish()

    logger.info("Training complete! The model has been saved and is ready for multi-task inference.")
    return 0


if __name__ == "__main__":
    sys.exit(main())