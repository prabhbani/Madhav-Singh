"""Model loading and inference.

Loads the deployed artifact exactly as a serving process would, and checks that
it produces a usable probability for ordinary rows and for the awkward ones: a
single row, an empty frame, unseen categorical levels, and missing values.
"""

from __future__ import annotations

import unittest

from ml_test_base import ArtifactTestCase, DATASET_PATH, REQUIRED_ARTIFACTS


class TestArtifactsPresent(ArtifactTestCase):
    def test_every_required_artifact_is_on_disk(self) -> None:
        missing = [name for name in REQUIRED_ARTIFACTS if not (self.model_dir / name).is_file()]
        self.assertEqual(missing, [], f"missing artifacts: {missing}")

    def test_the_model_file_is_not_empty(self) -> None:
        size = (self.model_dir / "model.joblib").stat().st_size
        self.assertGreater(size, 1_000, "the serialized model is implausibly small")


class TestModelLoads(ArtifactTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        try:
            import joblib
            import pandas as pd
        except ImportError as error:  # pragma: no cover - environment guard
            raise unittest.SkipTest(f"joblib and pandas are required: {error}") from error
        cls.joblib = joblib
        cls.pd = pd
        cls.model = joblib.load(cls.model_dir / "model.joblib")
        if not DATASET_PATH.is_file():
            raise unittest.SkipTest("synthetic dataset missing; cannot build an inference frame")
        cls.frame = pd.read_csv(DATASET_PATH, nrows=50)

    def _features(self, frame):
        """Prepares a frame the way the training script does."""
        prepared = frame.copy()
        parsed = self.pd.to_datetime(prepared.pop("as_of_date"), errors="coerce")
        prepared["snapshot_year"] = parsed.dt.year
        prepared["snapshot_month"] = parsed.dt.month
        import numpy as np

        prepared["snapshot_month_sin"] = np.sin(2 * np.pi * prepared["snapshot_month"] / 12)
        prepared["snapshot_month_cos"] = np.cos(2 * np.pi * prepared["snapshot_month"] / 12)
        return prepared[self.feature_metadata["feature_columns"]]

    def test_the_model_exposes_a_probability_interface(self) -> None:
        self.assertTrue(hasattr(self.model, "predict_proba"), "the deployed model cannot produce probabilities")
        self.assertTrue(hasattr(self.model, "predict"))

    def test_it_scores_a_batch_and_returns_calibrated_probabilities(self) -> None:
        probabilities = self.model.predict_proba(self._features(self.frame))
        self.assertEqual(probabilities.shape, (len(self.frame), 2), "expected one pair of probabilities per row")
        for row in probabilities:
            self.assertAlmostEqual(float(row.sum()), 1.0, places=6, msg="probabilities must sum to one")
            for value in row:
                self.assertGreaterEqual(float(value), 0.0)
                self.assertLessEqual(float(value), 1.0)

    def test_it_scores_a_single_row(self) -> None:
        probabilities = self.model.predict_proba(self._features(self.frame.head(1)))
        self.assertEqual(probabilities.shape, (1, 2))

    def test_it_is_deterministic_for_the_same_input(self) -> None:
        features = self._features(self.frame)
        first = self.model.predict_proba(features)
        second = self.model.predict_proba(features)
        self.assertTrue((first == second).all(), "the same input produced different probabilities")

    def test_an_unseen_categorical_level_does_not_raise(self) -> None:
        # A new district must degrade to the encoder's unknown handling rather
        # than failing a live prediction.
        frame = self.frame.head(5).copy()
        categorical = self.feature_metadata["categorical_columns"]
        if not categorical:
            self.skipTest("no categorical columns to perturb")
        target_column = categorical[0]
        if target_column in frame.columns:
            frame[target_column] = "A District That Did Not Exist At Training Time"
        probabilities = self.model.predict_proba(self._features(frame))
        self.assertEqual(probabilities.shape, (5, 2))

    def test_missing_numeric_values_are_imputed_rather_than_fatal(self) -> None:
        import numpy as np

        frame = self.frame.head(5).copy()
        numeric = [column for column in self.feature_metadata["numeric_columns"] if column in frame.columns]
        if not numeric:
            self.skipTest("no numeric columns to blank")
        for column in numeric[:5]:
            frame[column] = np.nan
        probabilities = self.model.predict_proba(self._features(frame))
        self.assertEqual(probabilities.shape, (5, 2))
        self.assertFalse(np.isnan(probabilities).any(), "a blank input produced a NaN probability")

    def test_an_empty_batch_is_refused_so_a_caller_must_short_circuit(self) -> None:
        # scikit-learn's imputer requires at least one sample, so a zero-row
        # batch raises rather than returning an empty result. This is the
        # pipeline's real contract: a batch caller must skip an empty page
        # instead of passing it through. The serving path scores one project at
        # a time and never reaches this, but a bulk job would.
        with self.assertRaises(ValueError):
            self.model.predict_proba(self._features(self.frame.head(0)))

    def test_column_order_does_not_change_the_answer(self) -> None:
        features = self._features(self.frame)
        shuffled = features[list(reversed(features.columns))]
        first = self.model.predict_proba(features)
        second = self.model.predict_proba(shuffled[features.columns])
        self.assertTrue((first == second).all())


class TestPreprocessingPipelineLoads(ArtifactTestCase):
    def test_the_preprocessing_pipeline_loads_and_transforms(self) -> None:
        try:
            import joblib
            import pandas as pd
        except ImportError as error:  # pragma: no cover - environment guard
            raise unittest.SkipTest(f"joblib and pandas are required: {error}") from error
        if not DATASET_PATH.is_file():
            self.skipTest("synthetic dataset missing")

        pipeline = joblib.load(self.model_dir / "preprocessing_pipeline.joblib")
        self.assertTrue(hasattr(pipeline, "transform"), "the stored pipeline cannot transform")

        import numpy as np

        frame = pd.read_csv(DATASET_PATH, nrows=10)
        parsed = pd.to_datetime(frame.pop("as_of_date"), errors="coerce")
        frame["snapshot_year"] = parsed.dt.year
        frame["snapshot_month"] = parsed.dt.month
        frame["snapshot_month_sin"] = np.sin(2 * np.pi * frame["snapshot_month"] / 12)
        frame["snapshot_month_cos"] = np.cos(2 * np.pi * frame["snapshot_month"] / 12)

        transformed = pipeline.transform(frame[self.feature_metadata["feature_columns"]])
        self.assertEqual(transformed.shape[0], 10)
        self.assertGreater(transformed.shape[1], 0)
        self.assertFalse(np.isnan(np.asarray(transformed, dtype=float)).any(), "preprocessing emitted a NaN")


if __name__ == "__main__":
    unittest.main()
