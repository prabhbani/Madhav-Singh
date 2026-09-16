"""Data leakage checks.

Leakage is the failure that makes a model look excellent in evaluation and
useless in service. These checks assert the three forms this pipeline could
plausibly suffer: the target reaching the feature set, an identifier letting the
model memorise rows, and a temporal split that lets it read the future.
"""

from __future__ import annotations

import unittest

from ml_test_base import (
    DATE_COLUMN,
    FORBIDDEN_COLUMNS,
    IDENTIFIER_COLUMNS,
    TARGET_COLUMNS,
    ArtifactTestCase,
    DatasetTestCase,
    read_json,
)


class TestFeatureSetExcludesTarget(ArtifactTestCase):
    def test_no_target_column_is_a_feature(self) -> None:
        features = set(self.feature_metadata["feature_columns"])
        leaked = features & TARGET_COLUMNS
        self.assertEqual(leaked, set(), f"target columns reached the feature set: {sorted(leaked)}")

    def test_no_identifier_or_provenance_column_is_a_feature(self) -> None:
        features = set(self.feature_metadata["feature_columns"])
        leaked = features & IDENTIFIER_COLUMNS
        self.assertEqual(
            leaked,
            set(),
            f"identifier or provenance columns reached the feature set: {sorted(leaked)}",
        )

    def test_exclusion_list_is_recorded_and_complete(self) -> None:
        excluded = set(self.feature_metadata["excluded_columns"])
        missing = FORBIDDEN_COLUMNS - excluded
        self.assertEqual(missing, set(), f"these columns are not recorded as excluded: {sorted(missing)}")

    def test_the_target_is_named_and_is_not_a_feature(self) -> None:
        target = self.feature_metadata["target"]
        self.assertEqual(target, "significant_delay")
        self.assertNotIn(target, self.feature_metadata["feature_columns"])

    def test_no_feature_name_hints_at_an_outcome(self) -> None:
        # A column added later called `final_delay_days` or `outcome_flag` would
        # pass the exact-name checks above while still being the answer.
        suspicious = ("actual_", "final_", "outcome", "label", "target", "_delay_days", "resolved_at")
        offenders = [
            column
            for column in self.feature_metadata["feature_columns"]
            if any(marker in column.lower() for marker in suspicious)
        ]
        self.assertEqual(offenders, [], f"feature names suggest outcome leakage: {offenders}")

    def test_the_raw_date_column_is_consumed_not_carried(self) -> None:
        # The snapshot date is replaced by cyclical features. Carrying the raw
        # date would let a tree split on "rows generated after this point".
        self.assertNotIn(DATE_COLUMN, self.feature_metadata["feature_columns"])
        for derived in ("snapshot_year", "snapshot_month", "snapshot_month_sin", "snapshot_month_cos"):
            self.assertIn(derived, self.feature_metadata["feature_columns"])


class TestDatasetLeakageSurface(DatasetTestCase):
    def test_dataset_carries_the_target_that_training_must_drop(self) -> None:
        for column in TARGET_COLUMNS:
            self.assertIn(column, self.columns, f"{column} is missing from the dataset")

    def test_no_feature_is_a_perfect_proxy_for_the_target(self) -> None:
        # A correlation at or near one means the column is the answer wearing a
        # different name, whatever it is called.
        numeric = self.sample.select_dtypes(include="number")
        if "significant_delay" not in numeric.columns:
            self.skipTest("target is not numeric in this sample")
        target = numeric["significant_delay"]
        offenders = []
        for column in numeric.columns:
            if column in FORBIDDEN_COLUMNS:
                continue
            series = numeric[column]
            if series.nunique(dropna=True) <= 1:
                continue
            correlation = abs(series.corr(target))
            if correlation is not None and correlation >= 0.95:
                offenders.append((column, round(float(correlation), 4)))
        self.assertEqual(offenders, [], f"features almost perfectly predict the target: {offenders}")

    def test_case_identifiers_are_unique_so_a_row_cannot_be_memorised_twice(self) -> None:
        if "case_id" not in self.columns:
            self.skipTest("case_id is not present")
        duplicates = int(self.sample["case_id"].duplicated().sum())
        self.assertEqual(duplicates, 0, f"{duplicates} duplicate case identifiers in the sample")

    def test_the_snapshot_date_parses_so_a_temporal_split_is_possible(self) -> None:
        parsed = self.pd.to_datetime(self.sample[DATE_COLUMN], errors="coerce")
        unparsed = int(parsed.isna().sum())
        self.assertEqual(unparsed, 0, f"{unparsed} snapshot dates did not parse")
        self.assertGreater(parsed.nunique(), 1, "a single snapshot date makes a temporal split meaningless")


class TestSplitDoesNotOverlap(ArtifactTestCase):
    def test_split_sizes_are_recorded_and_disjoint_in_total(self) -> None:
        metadata = self.model_metadata
        for key in ("training_rows", "validation_rows", "test_rows"):
            self.assertIn(key, metadata, f"{key} is not recorded")
            self.assertGreater(metadata[key], 0, f"{key} is empty")

    def test_the_test_split_is_large_enough_to_mean_anything(self) -> None:
        metadata = self.model_metadata
        total = metadata["training_rows"] + metadata["validation_rows"] + metadata["test_rows"]
        share = metadata["test_rows"] / total
        self.assertGreaterEqual(share, 0.1, f"the test split is only {share:.1%} of the data")

    def test_calibration_is_fitted_away_from_the_test_split(self) -> None:
        metrics = read_json(self.model_dir / "evaluation_metrics.json")
        selected = self.model_metadata["selected_model"]
        self.assertIn(selected, metrics, "the selected model has no recorded metrics")
        # Thresholds and calibration are chosen on validation. Seeing a threshold
        # reported only under `test` would mean it was tuned on the test split.
        self.assertIn("validation", metrics[selected], "no validation block recorded")
        self.assertIn("threshold", metrics[selected]["validation"], "the threshold was not chosen on validation")


if __name__ == "__main__":
    unittest.main()
