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


def get_project_root() -> Path:
    """Traverse up from this file's path until archetype_classifier is found, or fallback to parent levels."""
    current = Path(__file__).resolve().parent
    for _ in range(6):
        if (current / "archetype_classifier").is_dir():
            return current
        if current.parent == current:
            break
        current = current.parent
    return Path(__file__).resolve().parents[4]  # Fallback to Repo root


def config_path() -> Path:
    override = os.getenv("ARCHETYPE_CONFIG_PATH")
    return Path(override) if override else _DEFAULT_CONFIG_PATH


def load_config() -> dict | None:
    """Return the parsed config, or ``None`` if missing/unreadable/disabled."""
    path = config_path()
    cfg = {}
    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not read archetype config %s: %s", path, e)
    else:
        logger.info("Archetype config not found at %s. Checking env overrides.", path)

    # Apply environment overrides
    if os.getenv("ARCHETYPE_ENABLED") is not None:
        cfg["enabled"] = os.getenv("ARCHETYPE_ENABLED").lower() in ("true", "1", "yes")

    for key in ["python_executable", "script_path", "checkpoint_dir", "label_mapping_path", "device"]:
        env_val = os.getenv(f"ARCHETYPE_{key.upper()}")
        if env_val is not None:
            cfg[key] = env_val

    # If config file doesn't exist and no environment variables are set, disable
    has_any_archetype_env = any(
        os.getenv(f"ARCHETYPE_{k.upper()}") is not None
        for k in ["ENABLED", "PYTHON_EXECUTABLE", "SCRIPT_PATH", "CHECKPOINT_DIR", "LABEL_MAPPING_PATH", "DEVICE"]
    )
    if not path.is_file() and not has_any_archetype_env:
        logger.info("Archetype config not found and no ARCHETYPE_* env variables set — classification disabled.")
        return None

    if not cfg.get("enabled", True):
        logger.info("Archetype classification disabled.")
        return None

    # Resolve relative paths relative to project root
    root = get_project_root()
    for key in ["script_path", "checkpoint_dir", "label_mapping_path"]:
        if key in cfg and cfg[key]:
            path_val = Path(cfg[key])
            if not path_val.is_absolute():
                cfg[key] = str((root / path_val).resolve())

    return cfg
