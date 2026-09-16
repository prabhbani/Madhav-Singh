"""Feature consistency between the dataset, the artifact, and the serving path.

The failure this guards against is silent: a column renamed in the dataset, or a
feature added to the model but never sent at inference, produces predictions that
are wrong rather than predictions that fail.
"""

from __future__ import annotations

import unittest

from ml_test_base import DATE_COLUMN, FORBIDDEN_COLUMNS, ArtifactTestCase, DatasetTestCase, read_json


class TestFeatureMetadataShape(ArtifactTestCase):
    def test_numeric_and_categorical_columns_partition_the_feature_set(self) -> None:
        features = set(self.feature_metadata["feature_columns"])
        numeric = set(self.feature_metadata["numeric_columns"])
        categorical = set(self.feature_metadata["categorical_columns"])

        overlap = numeric & categorical
        self.assertEqual(overlap, set(), f"columns typed both ways: {sorted(overlap)}")

        unclassified = features - numeric - categorical
        self.assertEqual(unclassified, set(), f"features with no declared type: {sorted(unclassified)}")

        stray = (numeric | categorical) - features
        self.assertEqual(stray, set(), f"typed columns that are not features: {sorted(stray)}")

    def test_no_feature_is_declared_twice(self) -> None:
        features = self.feature_metadata["feature_columns"]
        self.assertEqual(len(features), len(set(features)), "the feature list contains a duplicate")

    def test_the_feature_set_is_not_empty_and_is_plausibly_sized(self) -> None:
        count = len(self.feature_metadata["feature_columns"])
        self.assertGreater(count, 20, "suspiciously few features")
        self.assertLess(count, 500, "suspiciously many features for this dataset")


class TestFeaturesMatchTheDataset(DatasetTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from ml_test_base import latest_model_dir

        model_dir = latest_model_dir()
        if model_dir is None:
            raise unittest.SkipTest("no trained model found; run `python3 ml/train_models.py`")
        cls.feature_metadata = read_json(model_dir / "feature_metadata.json")

    def test_every_source_feature_exists_in_the_dataset(self) -> None:
        # Derived features are built during preparation and are not dataset columns.
        derived = {"snapshot_year", "snapshot_month", "snapshot_month_sin", "snapshot_month_cos"}
        expected = set(self.feature_metadata["feature_columns"]) - derived
        missing = expected - set(self.columns)
        self.assertEqual(missing, set(), f"the model expects columns the dataset does not have: {sorted(missing)}")

    def test_every_usable_dataset_column_is_either_a_feature_or_excluded(self) -> None:
        # A column that is neither is a silent omission: it exists, it is usable,
        # and nobody decided whether the model should see it.
        accounted = set(self.feature_metadata["feature_columns"]) | FORBIDDEN_COLUMNS | {DATE_COLUMN}
        optional_flags = {column for column in self.columns if column.startswith("missing_optional_")}
        unaccounted = set(self.columns) - accounted - optional_flags
        self.assertEqual(unaccounted, set(), f"dataset columns nobody decided about: {sorted(unaccounted)}")

    def test_numeric_features_really_are_numeric_in_the_dataset(self) -> None:
        derived = {"snapshot_year", "snapshot_month", "snapshot_month_sin", "snapshot_month_cos"}
        offenders = []
        for column in self.feature_metadata["numeric_columns"]:
            if column in derived or column not in self.columns:
                continue
            if not self.pd.api.types.is_numeric_dtype(self.sample[column]):
                offenders.append(column)
        self.assertEqual(offenders, [], f"declared numeric but not numeric in the data: {offenders}")

    def test_categorical_features_have_a_bounded_number_of_levels(self) -> None:
        # A categorical column with thousands of levels one-hot encodes into a
        # feature explosion and usually means an identifier slipped in.
        offenders = []
        for column in self.feature_metadata["categorical_columns"]:
            if column not in self.columns:
                continue
            levels = int(self.sample[column].nunique(dropna=True))
            if levels > 200:
                offenders.append((column, levels))
        self.assertEqual(offenders, [], f"categorical columns with too many levels: {offenders}")


class TestServingFeaturesMatchTraining(DatasetTestCase):
    """The backend reads a stored snapshot back into metrics by column name."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from ml_test_base import latest_model_dir

        model_dir = latest_model_dir()
        if model_dir is None:
            raise unittest.SkipTest("no trained model found; run `python3 ml/train_models.py`")
        cls.feature_metadata = read_json(model_dir / "feature_metadata.json")

    def test_the_columns_the_backend_reads_back_are_real_features(self) -> None:
        # These are the snake_case keys `readMetricsFromSnapshot` looks for. A
        # rename on either side breaks the alert and recommendation engines
        # quietly, because a missing key simply means "no evidence".
        backend_reads = {
            "parcel_count",
            "affected_landowner_count",
            "unresolved_record_count",
            "objection_count",
            "unresolved_objection_count",
            "required_document_count",
            "missing_document_count",
            "invalid_document_count",
            "document_verification_pending_count",
            "pending_approval_count",
            "blocked_dependency_count",
            "pending_compensation_amount",
            "payment_processing_days",
            "open_legal_case_count",
            "days_in_current_stage",
            "average_stage_duration_days",
            "overdue_days",
            "milestone_slippage_count",
            "days_since_last_update",
            "disputed_ownership_flag",
            "compensation_approval_pending_flag",
            "legal_dispute_flag",
            "stay_order_flag",
        }
        missing = backend_reads - set(self.columns)
        self.assertEqual(
            missing,
            set(),
            f"the backend reads columns the dataset no longer has: {sorted(missing)}",
        )

    def test_flag_columns_carry_only_two_values(self) -> None:
        offenders = []
        for column in self.columns:
            if not column.endswith("_flag"):
                continue
            values = set(self.sample[column].dropna().unique().tolist())
            if not values <= {0, 1, True, False}:
                offenders.append((column, sorted(map(str, values))[:5]))
        self.assertEqual(offenders, [], f"flag columns with values beyond zero and one: {offenders}")

    def test_count_columns_are_never_negative(self) -> None:
        offenders = []
        for column in self.columns:
            if not (column.endswith("_count") or column.endswith("_days")):
                continue
            if not self.pd.api.types.is_numeric_dtype(self.sample[column]):
                continue
            minimum = self.sample[column].min()
            if self.pd.notna(minimum) and minimum < 0:
                offenders.append((column, float(minimum)))
        self.assertEqual(offenders, [], f"count or duration columns with negative values: {offenders}")


if __name__ == "__main__":
    unittest.main()
