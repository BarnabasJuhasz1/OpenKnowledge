"""OK score engine.

Pure mathematical module — no DB or routing dependencies.
Handles bulk vectorized scoring and single-paper breakdowns.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def score_papers_bulk(
    df: pd.DataFrame,
    weights: dict[str, float],
) -> pd.DataFrame:
    """Apply the OK score formula to every row and return sorted results.

    Parameters
    ----------
    df : DataFrame
        Must contain columns: ``citation_count``, ``has_public_code``,
        ``is_peer_reviewed``, ``has_dataset``, ``repo_stars``.
        Additional columns are preserved.
    weights : dict
        Keys: ``w_c``, ``w_code``, ``w_peer``, ``w_data``, ``w_stars``.

    Returns
    -------
    DataFrame with a new ``ok_score`` column, sorted descending.
    """
    df = df.copy()

    # Fill NaN with 0 and cast booleans to int
    citations = df["citation_count"].fillna(0).astype(float)
    has_code = df["has_public_code"].fillna(False).astype(int)
    is_peer = df["is_peer_reviewed"].fillna(False).astype(int)
    has_data = df["has_dataset"].fillna(False).astype(int)
    stars = df["repo_stars"].fillna(0).astype(float)

    w_c = weights.get("w_c", 1.0)
    w_code = weights.get("w_code", 1.0)
    w_peer = weights.get("w_peer", 1.0)
    w_data = weights.get("w_data", 1.0)
    w_stars = weights.get("w_stars", 1.0)

    df["ok_score"] = (
        w_c * np.log10(1 + citations)
        + w_code * has_code
        + w_peer * is_peer
        + w_data * has_data
        + w_stars * np.log10(1 + stars)
    )

    # Round to 2 decimal places
    df["ok_score"] = df["ok_score"].round(2)

    return df.sort_values("ok_score", ascending=False).reset_index(drop=True)


def score_paper_single(
    paper_data: dict,
    weights: dict[str, float],
) -> dict:
    """Score a single paper and return a detailed breakdown.

    Parameters
    ----------
    paper_data : dict
        Must contain keys: ``citation_count``, ``has_public_code``,
        ``is_peer_reviewed``, ``has_dataset``, ``repo_stars``.
    weights : dict
        Keys: ``w_c``, ``w_code``, ``w_peer``, ``w_data``, ``w_stars``.

    Returns
    -------
    dict with ``total_score`` (float) and ``breakdown`` (dict of contributions).
    """
    citations = float(paper_data.get("citation_count") or 0)
    has_code = int(bool(paper_data.get("has_public_code")))
    is_peer = int(bool(paper_data.get("is_peer_reviewed")))
    has_data = int(bool(paper_data.get("has_dataset")))
    stars = float(paper_data.get("repo_stars") or 0)

    w_c = weights.get("w_c", 1.0)
    w_code = weights.get("w_code", 1.0)
    w_peer = weights.get("w_peer", 1.0)
    w_data = weights.get("w_data", 1.0)
    w_stars = weights.get("w_stars", 1.0)

    citations_contribution = round(w_c * float(np.log10(1 + citations)), 2)
    code_contribution = round(w_code * has_code, 2)
    peer_review_contribution = round(w_peer * is_peer, 2)
    dataset_contribution = round(w_data * has_data, 2)
    stars_contribution = round(w_stars * float(np.log10(1 + stars)), 2)

    total_score = round(
        citations_contribution
        + code_contribution
        + peer_review_contribution
        + dataset_contribution
        + stars_contribution,
        2,
    )

    return {
        "total_score": total_score,
        "breakdown": {
            "citations_contribution": citations_contribution,
            "code_contribution": code_contribution,
            "peer_review_contribution": peer_review_contribution,
            "dataset_contribution": dataset_contribution,
            "stars_contribution": stars_contribution,
        },
    }
