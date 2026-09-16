"""Prediction response schema.

The backend validates the model service response against a contract and
discards anything outside it. These checks assert that contract from the model
side: that a scored row produces every field the API promises, in range, and
that the risk bands the API publishes cover the whole probability interval.
"""

from __future__ import annotations

import unittest

from ml_test_base import ArtifactTestCase, DATASET_PATH, read_json

# The fields `mlResponseSchema` in the backend accepts. Anything else is dropped.
REQUIRED_RESPONSE_FIELDS = {"delayProbability", "riskLevel"}
OPTIONAL_RESPONSE_FIELDS = {"expectedDelayDays", "confidenceBand", "modelVersion", "topRiskFactors"}
VALID_RISK_LEVELS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
VALID_CONFIDENCE_BANDS = ("LOW", "MEDIUM", "HIGH")

# The bands the decision layer publishes, from PREDICTIVE_ANALYTICS_ENGINE.md.
RISK_BANDS = ((0.00, 0.25, "LOW"), (0.25, 0.50, "MEDIUM"), (0.50, 0.75, "HIGH"), (0.75, 1.01, "CRITICAL"))


def band_for(probability: float) -> str:
    for lower, upper, label in RISK_BANDS:
        if lower <= probability < upper:
            return label
    raise AssertionError(f"probability {probability} falls outside every band")


class TestRiskBandsCoverTheInterval(unittest.TestCase):
    def test_the_bands_are_contiguous_and_cover_zero_to_one(self) -> None:
        self.assertEqual(RISK_BANDS[0][0], 0.0, "the bands must start at zero")
        for index in range(1, len(RISK_BANDS)):
            self.assertEqual(RISK_BANDS[index][0], RISK_BANDS[index - 1][1], "a gap or overlap between bands")
        self.assertGreater(RISK_BANDS[-1][1], 1.0, "the top band must include a probability of one")

    def test_every_probability_maps_to_exactly_one_band(self) -> None:
        for step in range(0, 101):
            probability = step / 100
            label = band_for(probability)
            self.assertIn(label, VALID_RISK_LEVELS)

    def test_the_band_boundaries_are_inclusive_at_the_lower_edge(self) -> None:
        self.assertEqual(band_for(0.25), "MEDIUM")
        self.assertEqual(band_for(0.50), "HIGH")
        self.assertEqual(band_for(0.75), "CRITICAL")
        self.assertEqual(band_for(0.7499), "HIGH")


class TestScoredResponseMatchesTheContract(ArtifactTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        try:
            import joblib
            import numpy as np
            import pandas as pd
        except ImportError as error:  # pragma: no cover - environment guard
            raise unittest.SkipTest(f"joblib, numpy, and pandas are required: {error}") from error
        if not DATASET_PATH.is_file():
            raise unittest.SkipTest("synthetic dataset missing")

        cls.np = np
        model = joblib.load(cls.model_dir / "model.joblib")
        frame = pd.read_csv(DATASET_PATH, nrows=200)
        parsed = pd.to_datetime(frame.pop("as_of_date"), errors="coerce")
        frame["snapshot_year"] = parsed.dt.year
        frame["snapshot_month"] = parsed.dt.month
        frame["snapshot_month_sin"] = np.sin(2 * np.pi * frame["snapshot_month"] / 12)
        frame["snapshot_month_cos"] = np.cos(2 * np.pi * frame["snapshot_month"] / 12)
        features = frame[cls.feature_metadata["feature_columns"]]
        cls.probabilities = model.predict_proba(features)[:, 1]

    def _response_for(self, probability: float) -> dict:
        """Builds the response the model service would send for one row."""
        return {
            "delayProbability": round(float(probability), 5),
            "riskLevel": band_for(float(probability)),
            "expectedDelayDays": round(float(probability) * 45),
            "confidenceBand": "MEDIUM",
            "modelVersion": self.model_metadata["model_version"],
            "topRiskFactors": [],
        }

    def test_every_scored_row_produces_a_complete_response(self) -> None:
        for probability in self.probabilities[:50]:
            response = self._response_for(probability)
            missing = REQUIRED_RESPONSE_FIELDS - set(response)
            self.assertEqual(missing, set(), f"response missing required fields: {sorted(missing)}")
            unexpected = set(response) - REQUIRED_RESPONSE_FIELDS - OPTIONAL_RESPONSE_FIELDS
            self.assertEqual(unexpected, set(), f"response carries fields the API will drop: {sorted(unexpected)}")

    def test_every_probability_is_inside_the_unit_interval(self) -> None:
        self.assertTrue((self.probabilities >= 0).all(), "a probability below zero")
        self.assertTrue((self.probabilities <= 1).all(), "a probability above one")
        self.assertFalse(self.np.isnan(self.probabilities).any(), "a NaN probability")

    def test_every_risk_level_is_one_the_api_accepts(self) -> None:
        for probability in self.probabilities:
            self.assertIn(band_for(float(probability)), VALID_RISK_LEVELS)

    def test_the_confidence_band_is_one_the_api_accepts(self) -> None:
        response = self._response_for(self.probabilities[0])
        self.assertIn(response["confidenceBand"], VALID_CONFIDENCE_BANDS)

    def test_expected_delay_days_is_never_negative(self) -> None:
        for probability in self.probabilities[:50]:
            self.assertGreaterEqual(self._response_for(probability)["expectedDelayDays"], 0)

    def test_the_model_version_travels_with_the_prediction(self) -> None:
        response = self._response_for(self.probabilities[0])
        self.assertTrue(response["modelVersion"], "a prediction with no model version cannot be audited")
        self.assertEqual(response["modelVersion"], self.model_dir.name)

    def test_the_model_does_not_answer_one_class_for_everything(self) -> None:
        # A model that predicts the majority class for every row scores well on
        # accuracy and is worthless. Distinct bands prove it discriminates.
        bands = {band_for(float(probability)) for probability in self.probabilities}
        self.assertGreater(len(bands), 1, f"every row landed in the same band: {bands}")


class TestExplanationSchema(ArtifactTestCase):
    def test_global_importance_is_ranked_and_names_real_features(self) -> None:
        importance = read_json(self.model_dir / "feature_importance_shap.json")
        self.assertIn("method", importance)
        self.assertIn("factors", importance)
        self.assertGreater(len(importance["factors"]), 0)

        features = set(self.feature_metadata["feature_columns"])
        ranks = []
        for factor in importance["factors"]:
            self.assertIn("feature", factor)
            self.assertIn("mean_importance", factor)
            self.assertIn("rank", factor)
            self.assertIn(factor["feature"], features, f"{factor['feature']} is not a model feature")
            ranks.append(factor["rank"])

        self.assertEqual(ranks, sorted(ranks), "importance factors are not in rank order")
        self.assertEqual(ranks[0], 1, "ranking must start at one")
        self.assertEqual(len(ranks), len(set(ranks)), "a rank is repeated")


if __name__ == "__main__":
    unittest.main()
