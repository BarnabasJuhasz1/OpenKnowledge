"""Loads the archetype-classifier configuration.

A single JSON file (default ``config.json`` next to this module, overridable via
the ``ARCHETYPE_CONFIG_PATH`` env var) drives the whole feature, so it can be
re-pointed at a different checkpoint / conda env without touching code.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"


def config_path() -> Path:
    override = os.getenv("ARCHETYPE_CONFIG_PATH")
    return Path(override) if override else _DEFAULT_CONFIG_PATH


def load_config() -> dict | None:
    """Return the parsed config, or ``None`` if missing/unreadable/disabled."""
    path = config_path()
    if not path.is_file():
        logger.info("Archetype config not found at %s — classification disabled.", path)
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not read archetype config %s: %s", path, e)
        return None

    if not cfg.get("enabled", True):
        logger.info("Archetype classification disabled via config.")
        return None
    return cfg
