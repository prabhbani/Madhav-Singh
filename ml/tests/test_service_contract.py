"""Prediction service contract.

The backend and this service agree on a payload shape and a response shape. That
agreement was once broken in a way nothing caught: the backend sent five fields
of operational metadata, none of which was a training column, so every request
arrived with the whole feature vector missing and the model scored a row the
imputer had invented. It still returned a confident-looking number.

These tests pin both halves of the contract, and the feature names in particular,
because a rename on either side breaks scoring silently rather than loudly.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent / "service"
sys.path.insert(0, str(SERVICE_DIR))

# The feature names the backend sends. Mirrors `buildFeaturePayload` in
# `backend/src/services/predictionService.ts`.
BACKEND_SENDS = {
    "state",
    "district",
    "department",
    "project_type",
    "project_priority",
    "required_document_count",
    "missing_document_count",
    "invalid_document_count",
    "document_verification_pending_count",
    "milestone_slippage_count",
    "overdue_days",
    "days_in_current_stage",
    "average_stage_duration_days",
    "days_since_last_update",
    "parcel_count",
    "affected_landowner_count",
    "unresolved_record_count",
    "objection_count",
    "unresolved_objection_count",
    "pending_approval_count",
    "blocked_dependency_count",
    "pending_compensation_amount",
    "payment_processing_days",
    "open_legal_case_count",
    "disputed_ownership_flag",
    "legal_dispute_flag",
    "compensation_approval_pending_flag",
    "stay_order_flag",
}

REALISTIC_FEATURES = {
    "state": "Punjab",
    "district": "Amritsar",
    "department": "National Highways Authority",
    "project_type": "EXPRESSWAY",
    "project_priority": "CRITICAL",
    "parcel_count": 287,
    "affected_landowner_count": 394,
    "unresolved_record_count": 68,
    "unresolved_objection_count": 47,
    "missing_document_count": 21,
    "payment_processing_days": 94,
    "open_legal_case_count": 2,
    "overdue_days": 38,
    "days_in_current_stage": 118,
    "milestone_slippage_count": 4,
    "pending_approval_count": 7,
    "disputed_ownership_flag": 1,
    "legal_dispute_flag": 1,
}


def build_client():
    try:
        from fastapi.testclient import TestClient
    except ImportError as error:  # pragma: no cover - environment guard
        raise unittest.SkipTest(f"fastapi is required for the service tests: {error}") from error
    import app as service

    return TestClient(service.app), service


class ServiceTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client_factory = build_client
        client, service = build_client()
        if service.resolve_model_directory() is None:
            raise unittest.SkipTest("no trained model artifact; run `python3 ml/train_models.py`")
        cls.client = client
        cls.service = service
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "client"):
            cls.client.__exit__(None, None, None)


class TestHealthEndpoints(ServiceTestCase):
    def test_health_answers_and_names_the_service(self) -> None:
        for path in ("/health", "/api/health"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            body = response.json()
            self.assertEqual(body["service"], "land-acquisition-ml")
            self.assertIn(body["status"], {"ok", "degraded"})

    def test_health_reports_the_loaded_model_version(self) -> None:
        body = self.client.get("/health").json()
        self.assertTrue(body["modelLoaded"])
        self.assertTrue(body["modelVersion"])

    def test_health_labels_the_data_as_synthetic(self) -> None:
        self.assertEqual(self.client.get("/health").json()["dataOrigin"], "SYNTHETIC_DEMO")

    def test_readiness_passes_once_a_model_is_loaded(self) -> None:
        self.assertEqual(self.client.get("/ready").status_code, 200)

    def test_health_does_not_leak_the_artifact_path(self) -> None:
        body = self.client.get("/health").text
        self.assertNotIn("/artifacts/", body)
        self.assertNotIn("joblib", body)


class TestFeatureContract(ServiceTestCase):
    def test_every_name_the_backend_sends_is_a_model_feature(self) -> None:
        columns = set(self.service.BUNDLE.feature_columns)
        unknown = BACKEND_SENDS - columns
        self.assertEqual(
            unknown,
            set(),
            f"the backend sends names the model does not have: {sorted(unknown)}; "
            "a rename on either side breaks scoring silently",
        )

    def test_the_backend_supplies_more_than_the_minimum(self) -> None:
        # If this fails, the backend cannot score anything at all.
        self.assertGreater(
            len(BACKEND_SENDS),
            self.service.MIN_SUPPLIED_FEATURES,
            "the backend sends fewer features than the service requires",
        )

    def test_derived_features_are_not_expected_from_the_caller(self) -> None:
        for column in self.service.DERIVED_FEATURES:
            self.assertNotIn(column, BACKEND_SENDS, f"{column} is derived by the service, not sent")
            self.assertIn(column, self.service.BUNDLE.feature_columns)


class TestPrediction(ServiceTestCase):
    def _predict(self, features: dict, **extra):
        payload = {"projectId": "PB-ASR-2026-003", "horizonDays": 90, "features": features, **extra}
        return self.client.post("/predict", json=payload)

    def test_scores_a_realistic_case(self) -> None:
        response = self._predict(REALISTIC_FEATURES)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertGreaterEqual(body["delayProbability"], 0.0)
        self.assertLessEqual(body["delayProbability"], 1.0)
        self.assertIn(body["riskLevel"], {"LOW", "MEDIUM", "HIGH", "CRITICAL"})
        self.assertIn(body["confidenceBand"], {"LOW", "MEDIUM", "HIGH"})
        self.assertGreaterEqual(body["expectedDelayDays"], 0)
        self.assertTrue(body["modelVersion"])

    def test_returns_only_the_fields_the_backend_accepts(self) -> None:
        body = self._predict(REALISTIC_FEATURES).json()
        allowed = {
            "delayProbability",
            "expectedDelayDays",
            "riskLevel",
            "confidenceBand",
            "modelVersion",
            "topRiskFactors",
        }
        self.assertEqual(set(body), allowed, "the response shape drifted from the backend's schema")

    def test_explains_the_prediction_with_ranked_factors(self) -> None:
        factors = self._predict(REALISTIC_FEATURES).json()["topRiskFactors"]
        self.assertGreater(len(factors), 0, "a prediction with no explanation is not usable")
        shares = [factor["relativeContribution"] for factor in factors]
        self.assertEqual(shares, sorted(shares, reverse=True), "factors are not in rank order")
        for factor in factors:
            self.assertIn(factor["direction"], {"INCREASES_RISK", "REDUCES_RISK", "NEUTRAL"})
            self.assertGreaterEqual(factor["relativeContribution"], 0.0)
            self.assertLessEqual(factor["relativeContribution"], 1.0)
            self.assertGreater(len(factor["explanation"]), 20)

    def test_makes_no_causal_claim(self) -> None:
        for factor in self._predict(REALISTIC_FEATURES).json()["topRiskFactors"]:
            lowered = factor["explanation"].lower()
            for banned in ("caused", "will reduce", "guarantee", "ensures", "eliminates"):
                self.assertNotIn(banned, lowered)

    def test_never_exposes_model_internals(self) -> None:
        body = self._predict(REALISTIC_FEATURES).text
        for internal in ("coef_", "joblib", "LogisticRegression", "ColumnTransformer", "artifacts/"):
            self.assertNotIn(internal, body, f"{internal} reached the response")

    def test_refuses_the_payload_that_once_broke_the_contract(self) -> None:
        # Five fields of operational metadata, none a training column. This is
        # the exact payload the backend used to send.
        response = self._predict(
            {"projectId": "x", "status": "ACTIVE", "milestoneCount": 7, "overdueMilestones": 1, "dataOrigin": "SYNTHETIC_DEMO"}
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "INSUFFICIENT_FEATURES")

    def test_refuses_a_payload_too_thin_to_score_honestly(self) -> None:
        response = self._predict({"parcel_count": 10, "state": "Punjab"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "INSUFFICIENT_FEATURES")

    def test_reports_lower_confidence_for_a_sparser_case(self) -> None:
        full = self._predict(REALISTIC_FEATURES).json()["confidenceBand"]
        sparse_features = dict(list(REALISTIC_FEATURES.items())[:9])
        sparse = self._predict(sparse_features).json()["confidenceBand"]
        order = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
        self.assertLessEqual(order[sparse], order[full], "a sparser case must not report higher confidence")

    def test_handles_an_unseen_district_without_failing(self) -> None:
        features = {**REALISTIC_FEATURES, "district": "A District That Did Not Exist At Training Time"}
        self.assertEqual(self._predict(features).status_code, 200)

    def test_validates_the_request_at_the_boundary(self) -> None:
        for payload in (
            {"projectId": "", "features": REALISTIC_FEATURES},
            {"projectId": "x", "horizonDays": 0, "features": REALISTIC_FEATURES},
            {"projectId": "x", "horizonDays": 4000, "features": REALISTIC_FEATURES},
            {"features": REALISTIC_FEATURES},
        ):
            self.assertEqual(self.client.post("/predict", json=payload).status_code, 422, payload)

    def test_is_deterministic_for_the_same_case(self) -> None:
        first = self._predict(REALISTIC_FEATURES).json()
        second = self._predict(REALISTIC_FEATURES).json()
        self.assertEqual(first["delayProbability"], second["delayProbability"])

    def test_tolerates_an_unparseable_timestamp_rather_than_failing(self) -> None:
        response = self._predict(REALISTIC_FEATURES, asOfAt="not-a-date")
        self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
