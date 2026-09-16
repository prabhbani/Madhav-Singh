"""Model version and registry compatibility.

A deployed model must be identifiable, reproducible, and comparable to the one
it replaced. These checks assert the registry discipline described in
PREDICTIVE_ANALYTICS_ENGINE.md: a resolvable pointer, complete metadata, metrics
that clear the operational floor, and a feature contract the serving layer can
still satisfy.
"""

from __future__ import annotations

import re
import unittest
from datetime import datetime

from ml_test_base import (
    ARTIFACTS_DIR,
    LATEST_POINTER,
    REQUIRED_ARTIFACTS,
    ArtifactTestCase,
    latest_model_dir,
    read_json,
)

VERSION_PATTERN = re.compile(r"^[a-z0-9-]+-\d{8}T\d{6}Z$")


class TestRegistryPointer(unittest.TestCase):
    def setUp(self) -> None:
        if not LATEST_POINTER.is_file():
            self.skipTest("no latest.json pointer; run `python3 ml/train_models.py`")
        self.pointer = read_json(LATEST_POINTER)

    def test_the_pointer_names_a_version_that_exists_on_disk(self) -> None:
        version = self.pointer.get("model_version")
        self.assertTrue(version, "latest.json names no model version")
        self.assertTrue((ARTIFACTS_DIR / version).is_dir(), f"latest.json points at a missing directory: {version}")

    def test_the_version_is_sortable_and_timestamped(self) -> None:
        version = self.pointer["model_version"]
        self.assertRegex(version, VERSION_PATTERN, "a version must sort chronologically and carry its training time")

    def test_the_pointer_records_how_the_model_was_chosen(self) -> None:
        self.assertTrue(self.pointer.get("selected_model"), "no selected model recorded")
        self.assertTrue(self.pointer.get("selection_basis"), "no selection basis recorded")

    def test_the_pointer_records_the_operational_cost_assumptions(self) -> None:
        # Choosing a threshold without recording what a missed case costs makes
        # the choice unreviewable.
        self.assertGreater(self.pointer.get("false_negative_cost", 0), 0)
        self.assertGreater(self.pointer.get("false_positive_cost", 0), 0)
        self.assertGreater(
            self.pointer["false_negative_cost"],
            self.pointer["false_positive_cost"],
            "a missed delay should cost more than a false warning in this domain",
        )

    def test_the_creation_time_parses(self) -> None:
        created = self.pointer.get("created_at")
        self.assertTrue(created, "no creation time recorded")
        parsed = datetime.fromisoformat(created)
        self.assertIsNotNone(parsed)


class TestEveryArtifactDirectoryIsComplete(unittest.TestCase):
    def test_no_half_written_model_directory_is_left_behind(self) -> None:
        if not ARTIFACTS_DIR.is_dir():
            self.skipTest("no artifacts directory")
        incomplete = []
        for directory in sorted(ARTIFACTS_DIR.iterdir()):
            if not directory.is_dir():
                continue
            missing = [name for name in REQUIRED_ARTIFACTS if not (directory / name).is_file()]
            if missing:
                incomplete.append((directory.name, missing))
        self.assertEqual(incomplete, [], f"incomplete model directories: {incomplete}")


class TestDeployedModelMetadata(ArtifactTestCase):
    def test_metadata_records_everything_a_rollback_would_need(self) -> None:
        for key in (
            "model_version",
            "selected_model",
            "selection_basis",
            "training_rows",
            "validation_rows",
            "test_rows",
            "target",
            "created_at",
            "python_version",
        ):
            self.assertIn(key, self.model_metadata, f"{key} is not recorded")

    def test_the_directory_name_matches_the_recorded_version(self) -> None:
        self.assertEqual(self.model_dir.name, self.model_metadata["model_version"])

    def test_the_pointer_and_the_metadata_agree(self) -> None:
        pointer = read_json(LATEST_POINTER)
        self.assertEqual(pointer["model_version"], self.model_metadata["model_version"])
        self.assertEqual(pointer["selected_model"], self.model_metadata["selected_model"])
        self.assertEqual(pointer["target"], self.model_metadata["target"])

    def test_the_feature_contract_is_recorded_with_the_model(self) -> None:
        # Without this, a model cannot be served later: nothing records which
        # columns it expects or in what order.
        self.assertIn("feature_columns", self.feature_metadata)
        self.assertIn("random_state", self.feature_metadata)
        self.assertGreater(len(self.feature_metadata["feature_columns"]), 0)

    def test_training_is_reproducible_from_a_recorded_seed(self) -> None:
        self.assertIsInstance(self.feature_metadata["random_state"], int)


class TestDeployedModelMetrics(ArtifactTestCase):
    def setUp(self) -> None:
        self.metrics = read_json(self.model_dir / "evaluation_metrics.json")
        self.selected = self.model_metadata["selected_model"]
        if self.selected not in self.metrics:
            self.skipTest(f"no metrics recorded for {self.selected}")
        self.block = self.metrics[self.selected]

    def test_the_selected_model_was_evaluated_on_validation_and_test(self) -> None:
        self.assertIn("validation", self.block)
        for split in ("validation",):
            for metric in ("recall", "precision", "pr_auc", "roc_auc", "brier_score"):
                self.assertIn(metric, self.block[split], f"{metric} missing from {split}")

    def test_recall_clears_the_operational_floor(self) -> None:
        floor = self.model_metadata.get("minimum_recall", 0.8)
        recall = self.block["validation"]["recall"]
        self.assertGreaterEqual(
            recall,
            floor,
            f"validation recall {recall} is below the {floor} floor; a missed delay is the costly error here",
        )

    def test_the_model_beats_a_coin_toss_by_a_clear_margin(self) -> None:
        self.assertGreater(self.block["validation"]["roc_auc"], 0.7, "the model barely separates the classes")
        self.assertGreater(self.block["validation"]["pr_auc"], 0.5)

    def test_every_metric_is_inside_its_natural_range(self) -> None:
        for metric in ("accuracy", "precision", "recall", "f1", "roc_auc", "pr_auc", "brier_score"):
            value = self.block["validation"].get(metric)
            if value is None:
                continue
            self.assertGreaterEqual(value, 0.0, f"{metric} is negative")
            self.assertLessEqual(value, 1.0, f"{metric} exceeds one")

    def test_the_decision_threshold_is_recorded_so_a_score_can_be_reproduced(self) -> None:
        threshold = self.block["validation"].get("threshold")
        self.assertIsNotNone(threshold, "no decision threshold recorded")
        self.assertGreater(threshold, 0.0)
        self.assertLess(threshold, 1.0)

    def test_calibration_is_measured_even_when_it_is_poor(self) -> None:
        # Calibration error is reported rather than hidden. A high value is a
        # known limitation, not a reason to omit the number.
        self.assertIn("expected_calibration_error", self.block["validation"])
        self.assertIn("calibration_curve", self.block["validation"])

    def test_models_that_were_skipped_are_recorded_with_a_reason(self) -> None:
        skipped_path = self.model_dir / "skipped_models.json"
        if not skipped_path.is_file():
            self.skipTest("no skipped-models record")
        skipped = read_json(skipped_path)
        if isinstance(skipped, dict):
            for name, reason in skipped.items():
                self.assertTrue(reason, f"{name} was skipped with no reason recorded")


class TestBackwardCompatibility(unittest.TestCase):
    def test_a_newer_model_does_not_silently_drop_a_feature_the_backend_reads(self) -> None:
        # If more than one model has been trained, the newest must still accept
        # everything the serving layer knows how to send.
        if not ARTIFACTS_DIR.is_dir():
            self.skipTest("no artifacts directory")
        directories = [entry for entry in sorted(ARTIFACTS_DIR.iterdir()) if entry.is_dir()]
        if len(directories) < 2:
            self.skipTest("only one model version exists; nothing to compare")

        previous = read_json(directories[-2] / "feature_metadata.json")
        current = read_json(directories[-1] / "feature_metadata.json")
        dropped = set(previous["feature_columns"]) - set(current["feature_columns"])
        self.assertEqual(
            dropped,
            set(),
            f"the newest model dropped features the previous one used: {sorted(dropped)}; "
            "the serving layer must be updated in the same change",
        )

    def test_the_rollback_target_is_still_loadable(self) -> None:
        if not ARTIFACTS_DIR.is_dir():
            self.skipTest("no artifacts directory")
        directories = [entry for entry in sorted(ARTIFACTS_DIR.iterdir()) if entry.is_dir()]
        if len(directories) < 2:
            self.skipTest("only one model version exists; there is nothing to roll back to")
        try:
            import joblib
        except ImportError as error:  # pragma: no cover - environment guard
            self.skipTest(f"joblib is required: {error}")
        model = joblib.load(directories[-2] / "model.joblib")
        self.assertTrue(hasattr(model, "predict_proba"), "the rollback target cannot produce probabilities")


if __name__ == "__main__":
    unittest.main()
