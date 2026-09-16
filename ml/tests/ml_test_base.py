"""Shared helpers for the ML test suites.

Written as ``unittest.TestCase`` subclasses so the suites run under pytest and
under the standard library runner alike. A contributor without pytest installed
still gets a green run with ``python3 -m unittest``.

Every suite skips rather than fails when an artifact is absent, because a fresh
clone has not trained a model yet and a missing artifact is not a regression.
"""

from __future__ import annotations

import json
import unittest
from functools import lru_cache
from pathlib import Path
from typing import Any

ML_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ML_ROOT.parent
ARTIFACTS_DIR = ML_ROOT / "artifacts"
LATEST_POINTER = ARTIFACTS_DIR / "latest.json"
DATASET_PATH = REPO_ROOT / "data" / "synthetic_land_acquisition_cases.csv"

# Columns the training script must never see. Target columns leak the answer
# directly; the identifier and provenance columns let a model memorise rows or
# learn which synthetic scenario generated them.
TARGET_COLUMNS = {"significant_delay", "actual_delay_days", "risk_category"}
IDENTIFIER_COLUMNS = {"case_id", "project_id", "data_origin", "synthetic_scenario"}
FORBIDDEN_COLUMNS = TARGET_COLUMNS | IDENTIFIER_COLUMNS

# The date column is consumed and replaced by cyclical snapshot features.
DATE_COLUMN = "as_of_date"

REQUIRED_ARTIFACTS = (
    "model.joblib",
    "preprocessing_pipeline.joblib",
    "model_metadata.json",
    "feature_metadata.json",
    "evaluation_metrics.json",
    "feature_importance_shap.json",
)


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def latest_model_dir() -> Path | None:
    """The directory the ``latest.json`` pointer names, when it resolves."""
    if not LATEST_POINTER.is_file():
        return None
    pointer = read_json(LATEST_POINTER)
    version = pointer.get("model_version")
    if not version:
        return None
    candidate = ARTIFACTS_DIR / version
    return candidate if candidate.is_dir() else None


class ArtifactTestCase(unittest.TestCase):
    """Base for suites that need a trained model on disk."""

    model_dir: Path
    feature_metadata: dict[str, Any]
    model_metadata: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        model_dir = latest_model_dir()
        if model_dir is None:
            raise unittest.SkipTest(
                "no trained model found; run `python3 ml/train_models.py` to produce artifacts"
            )
        cls.model_dir = model_dir
        cls.feature_metadata = read_json(model_dir / "feature_metadata.json")
        cls.model_metadata = read_json(model_dir / "model_metadata.json")


class DatasetTestCase(unittest.TestCase):
    """Base for suites that need the training dataset."""

    @classmethod
    def setUpClass(cls) -> None:
        if not DATASET_PATH.is_file():
            raise unittest.SkipTest(
                "synthetic dataset missing; run `python3 data/generate_synthetic_dataset.py`"
            )
        try:
            import pandas as pd
        except ImportError as error:  # pragma: no cover - environment guard
            raise unittest.SkipTest(f"pandas is required for this suite: {error}") from error
        # nrows keeps the suite fast; the leakage checks are about columns, and
        # the row-level checks that need everything read the full file directly.
        cls.pd = pd
        cls.sample = pd.read_csv(DATASET_PATH, nrows=2000)
        cls.columns = list(cls.sample.columns)
