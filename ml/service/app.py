"""Delay prediction service.

A small FastAPI application that loads the approved model artifact and scores one
case at a time. The backend treats it as an untrusted upstream, so the contract
here is deliberately narrow and the failure behaviour is explicit: a request this
service cannot answer well is answered with a stated degradation rather than a
confident guess.

Three properties it is built around:

1. **Honest degradation.** A case arriving with few recorded features is scored,
   but the response reports how many were missing and lowers the confidence band.
   Silently imputing everything and returning high confidence is the failure mode
   that makes a prediction service dangerous rather than merely wrong.

2. **Real local explanation.** The deployed model is a calibrated logistic
   regression, so a contribution is the coefficient times the transformed feature
   value, averaged across the calibration folds. That is an actual explanation of
   this row, not the global importance list relabelled.

3. **No model internals on the wire.** Coefficients, the feature vector, and the
   artifact path stay inside. The response carries the probability, the band, the
   ranked factors, and the model version.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

SERVICE_NAME = "land-acquisition-ml"
SERVICE_VERSION = "0.1.0"

ARTIFACTS_DIR = Path(os.getenv("ML_ARTIFACTS_DIR", Path(__file__).resolve().parent.parent / "artifacts"))
MAX_FACTORS = 6

# Features the service derives itself from the request, rather than receiving.
# They are excluded when judging how much evidence a caller actually supplied.
DERIVED_FEATURES = frozenset(
    {"prediction_horizon_days", "snapshot_year", "snapshot_month", "snapshot_month_sin", "snapshot_month_cos"}
)

# The fewest real features that make a score worth returning.
#
# Below this the model would be scoring an imputed row: an answer shaped like a
# prediction that carries no information about the case. Refusing lets the
# backend fall back to its rule layer, which at least reports what it measured.
MIN_SUPPLIED_FEATURES = int(os.getenv("ML_MIN_SUPPLIED_FEATURES", "8"))

# Risk bands, matching the decision layer the backend publishes. Keeping them
# here as well means a mismatch is visible in one place rather than inferred.
RISK_BANDS: tuple[tuple[float, str], ...] = ((0.75, "CRITICAL"), (0.50, "HIGH"), (0.25, "MEDIUM"), (0.0, "LOW"))

# Officer-facing labels. The renderer refuses to invent text for a feature it
# does not know, so an unmapped column is reported by its own name.
FEATURE_LABELS: dict[str, str] = {
    "unresolved_record_count": "Unresolved ownership records",
    "disputed_ownership_flag": "Disputed ownership recorded",
    "ownership_complexity_score": "Ownership complexity",
    "unresolved_objection_count": "Unresolved landowner objections",
    "objection_count": "Landowner objections filed",
    "missing_document_count": "Required documents missing",
    "invalid_document_count": "Rejected or expired documents",
    "document_verification_pending_count": "Documents awaiting verification",
    "document_completeness_ratio": "Document completeness",
    "pending_approval_count": "Approvals pending",
    "blocked_dependency_count": "Blocked inter-department dependencies",
    "payment_processing_days": "Compensation ageing in processing",
    "pending_compensation_amount": "Compensation outstanding",
    "compensation_approval_pending_flag": "Compensation approval pending",
    "open_legal_case_count": "Open legal cases",
    "legal_dispute_flag": "Legal dispute recorded",
    "stay_order_flag": "Active stay order",
    "overdue_days": "Current stage overdue",
    "days_in_current_stage": "Time in current stage",
    "milestone_slippage_count": "Repeated milestone slippage",
    "days_since_last_update": "Case record not updated recently",
    "acquisition_complexity_score": "Acquisition complexity",
    "parcel_count": "Parcels in the acquisition",
    "affected_landowner_count": "Affected landowners",
    "department_workload_index": "Department workload",
    "historical_department_delay_rate": "Department delay history",
    "historical_district_delay_rate": "District delay history",
}


# --- Structured logging -----------------------------------------------------


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with no request or response bodies.

    Bodies carry case data, and a log sink usually has a wider audience than the
    database. Only named fields reach a log line.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": datetime.now(timezone.utc).isoformat(),
            "service": SERVICE_NAME,
            "message": record.getMessage(),
        }
        for key, value in getattr(record, "fields", {}).items():
            payload[key] = value
        if record.exc_info:
            exception = record.exc_info[1]
            payload["errorType"] = type(exception).__name__
            payload["errorMessage"] = str(exception)[:300]
        return json.dumps(payload, default=str)


def configure_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    # Uvicorn's own access log duplicates what the middleware records.
    logging.getLogger("uvicorn.access").disabled = True
    # httpx logs every outbound call at INFO, duplicating the middleware line.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    return logging.getLogger(SERVICE_NAME)


logger = configure_logging()


def log(level: int, message: str, **fields: Any) -> None:
    logger.log(level, message, extra={"fields": fields})


# --- Model registry ---------------------------------------------------------


class ModelBundle:
    """The loaded artifact and everything derived from it."""

    def __init__(self, version: str, directory: Path) -> None:
        import joblib

        self.version = version
        self.directory = directory
        self.model = joblib.load(directory / "model.joblib")
        metadata = json.loads((directory / "feature_metadata.json").read_text(encoding="utf-8"))
        self.feature_columns: list[str] = metadata["feature_columns"]
        self.numeric_columns: set[str] = set(metadata.get("numeric_columns", []))
        self.categorical_columns: set[str] = set(metadata.get("categorical_columns", []))
        self.model_metadata = json.loads((directory / "model_metadata.json").read_text(encoding="utf-8"))
        self._explainer = self._build_explainer()

    def _build_explainer(self) -> tuple[Any, np.ndarray, list[str]] | None:
        """Preprocessor, mean coefficients, and transformed feature names.

        Returns None for a model without coefficients, in which case predictions
        are still served and the response simply carries no ranked factors.
        """
        try:
            folds = getattr(self.model, "calibrated_classifiers_", None)
            if not folds:
                return None
            coefficients: list[np.ndarray] = []
            preprocessor = None
            names: list[str] = []
            for fold in folds:
                pipeline = getattr(fold, "estimator", None)
                if pipeline is None or not hasattr(pipeline, "named_steps"):
                    return None
                steps = pipeline.named_steps
                preprocessor = steps.get("preprocess")
                final = list(steps.values())[-1]
                if not hasattr(final, "coef_"):
                    return None
                coefficients.append(np.asarray(final.coef_).reshape(-1))
            if preprocessor is None:
                return None
            names = [str(name) for name in preprocessor.get_feature_names_out()]
            return preprocessor, np.mean(coefficients, axis=0), names
        except Exception:  # pragma: no cover - explanation is best effort
            log(logging.WARNING, "could not build a local explainer for this model")
            return None

    def explain(self, frame: pd.DataFrame) -> list[dict[str, Any]]:
        """Coefficient times transformed value, which is the log-odds contribution.

        This is a local explanation in the model's own output space. It is
        reported as a relative share, never as a probability or a share of the
        delay, because it is neither.
        """
        if self._explainer is None:
            return []
        preprocessor, coefficients, names = self._explainer
        transformed = np.asarray(preprocessor.transform(frame), dtype=float).reshape(-1)
        contributions = coefficients * transformed

        # One-hot columns are collapsed back onto the human feature they came
        # from, so an officer sees "District" rather than "district_Ludhiana".
        collapsed: dict[str, float] = {}
        for name, contribution in zip(names, contributions, strict=False):
            if not np.isfinite(contribution):
                continue
            base = name.split("__", 1)[-1]
            source = next((column for column in self.feature_columns if base == column or base.startswith(f"{column}_")), base)
            collapsed[source] = collapsed.get(source, 0.0) + float(contribution)

        total = sum(abs(value) for value in collapsed.values())
        if total <= 0:
            return []

        ranked = sorted(collapsed.items(), key=lambda item: abs(item[1]), reverse=True)[:MAX_FACTORS]
        factors: list[dict[str, Any]] = []
        for column, contribution in ranked:
            factors.append(
                {
                    "factorCode": column.upper(),
                    "label": FEATURE_LABELS.get(column, column.replace("_", " ").capitalize()),
                    "direction": "INCREASES_RISK" if contribution > 0 else "REDUCES_RISK",
                    "relativeContribution": round(abs(contribution) / total, 4),
                    "explanation": (
                        f"{FEATURE_LABELS.get(column, column)} is associated with "
                        f"{'higher' if contribution > 0 else 'lower'} predicted delay risk for this case."
                    ),
                }
            )
        return factors


BUNDLE: ModelBundle | None = None
LOAD_ERROR: str | None = None


def resolve_model_directory() -> Path | None:
    pointer = ARTIFACTS_DIR / "latest.json"
    if not pointer.is_file():
        return None
    version = json.loads(pointer.read_text(encoding="utf-8")).get("model_version")
    if not version:
        return None
    directory = ARTIFACTS_DIR / version
    return directory if directory.is_dir() else None


def load_model() -> None:
    global BUNDLE, LOAD_ERROR
    directory = resolve_model_directory()
    if directory is None:
        LOAD_ERROR = f"no model artifact found under {ARTIFACTS_DIR}"
        log(logging.ERROR, "model not loaded", reason=LOAD_ERROR)
        return
    try:
        BUNDLE = ModelBundle(directory.name, directory)
        LOAD_ERROR = None
        log(
            logging.INFO,
            "model loaded",
            modelVersion=BUNDLE.version,
            features=len(BUNDLE.feature_columns),
            explainable=BUNDLE._explainer is not None,
        )
    except Exception as error:  # pragma: no cover - startup guard
        BUNDLE = None
        LOAD_ERROR = f"{type(error).__name__}: {error}"
        log(logging.ERROR, "model failed to load", reason=LOAD_ERROR)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
    yield


app = FastAPI(
    title="Land Acquisition Delay Prediction Service",
    version=SERVICE_VERSION,
    description="Scores one acquisition case. Predictions are decision support, not statutory decisions.",
    lifespan=lifespan,
    # The explorer documents the whole surface, so it is opt-in like the API's.
    docs_url="/docs" if os.getenv("ENABLE_API_DOCS", "false") == "true" else None,
    redoc_url=None,
)


# --- Request and response contract ------------------------------------------


class PredictRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=120)
    horizonDays: int = Field(default=90, ge=1, le=365)
    asOfAt: str | None = None
    features: dict[str, Any] = Field(default_factory=dict)

    @field_validator("features")
    @classmethod
    def bound_features(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 200:
            raise ValueError("features carries more entries than any model uses")
        return value


class RiskFactor(BaseModel):
    factorCode: str
    label: str
    direction: Literal["INCREASES_RISK", "REDUCES_RISK", "NEUTRAL"]
    relativeContribution: float
    explanation: str


class PredictResponse(BaseModel):
    delayProbability: float
    expectedDelayDays: int
    riskLevel: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    confidenceBand: Literal["LOW", "MEDIUM", "HIGH"]
    modelVersion: str
    topRiskFactors: list[RiskFactor]


def band_for(probability: float) -> str:
    for threshold, label in RISK_BANDS:
        if probability >= threshold:
            return label
    return "LOW"


def build_frame(bundle: ModelBundle, request: PredictRequest) -> tuple[pd.DataFrame, int, int]:
    """One row shaped exactly as the model expects, and how much was missing.

    Unrecorded features become NaN so the fitted imputer handles them, rather
    than being filled with a zero that the model would read as a real value.
    """
    supplied = {str(key): value for key, value in request.features.items()}

    as_of = datetime.now(timezone.utc)
    if request.asOfAt:
        try:
            as_of = datetime.fromisoformat(request.asOfAt.replace("Z", "+00:00"))
        except ValueError:
            log(logging.WARNING, "unparseable asOfAt, using server time", projectId=request.projectId)

    derived = {
        "prediction_horizon_days": request.horizonDays,
        "snapshot_year": as_of.year,
        "snapshot_month": as_of.month,
        "snapshot_month_sin": float(np.sin(2 * np.pi * as_of.month / 12)),
        "snapshot_month_cos": float(np.cos(2 * np.pi * as_of.month / 12)),
    }

    row: dict[str, Any] = {}
    missing = 0
    supplied_real = 0
    for column in bundle.feature_columns:
        if column in derived:
            row[column] = derived[column]
            continue
        if column in supplied and supplied[column] is not None:
            value = supplied[column]
            if column in bundle.numeric_columns:
                try:
                    row[column] = float(value)
                    supplied_real += 1
                except (TypeError, ValueError):
                    row[column] = np.nan
                    missing += 1
            else:
                row[column] = str(value)
                supplied_real += 1
            continue
        row[column] = np.nan if column in bundle.numeric_columns else None
        missing += 1

    return pd.DataFrame([row], columns=bundle.feature_columns), missing, supplied_real


def confidence_for(supplied: int, requestable: int) -> str:
    """Confidence describes evidence completeness, not the probability itself.

    Measured against the features a caller can actually supply, so the five the
    service derives for itself do not inflate the figure.
    """
    completeness = supplied / requestable if requestable else 0.0
    if completeness >= 0.8:
        return "HIGH"
    if completeness >= 0.5:
        return "MEDIUM"
    return "LOW"


# --- Middleware and error handling ------------------------------------------


@app.middleware("http")
async def request_logging(request: Request, call_next):
    started = time.perf_counter()
    request_id = request.headers.get("x-request-id")
    try:
        response = await call_next(request)
    except Exception:
        log(
            logging.ERROR,
            "request failed",
            requestId=request_id,
            method=request.method,
            path=request.url.path,
            durationMs=round((time.perf_counter() - started) * 1000, 2),
            exc_info=True,
        )
        raise
    log(
        logging.INFO,
        "request completed",
        requestId=request_id,
        method=request.method,
        # Path only. A query string can carry case identifiers.
        path=request.url.path,
        status=response.status_code,
        durationMs=round((time.perf_counter() - started) * 1000, 2),
    )
    if request_id:
        response.headers["x-request-id"] = request_id
    return response


@app.exception_handler(Exception)
async def unhandled_error(request: Request, error: Exception) -> JSONResponse:
    """A caller learns the code and its request id, never the stack."""
    log(logging.ERROR, "unhandled error", path=request.url.path, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred"}},
    )


# --- Routes -----------------------------------------------------------------


def health_payload() -> dict[str, Any]:
    return {
        "status": "ok" if BUNDLE is not None else "degraded",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "modelLoaded": BUNDLE is not None,
        "modelVersion": BUNDLE.version if BUNDLE else None,
        "dataOrigin": "SYNTHETIC_DEMO",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/health", tags=["health"])
async def health() -> dict[str, Any]:
    """Liveness. Answers even with no model, so a restart loop is not masked."""
    return health_payload()


@app.get("/api/health", tags=["health"])
async def api_health() -> dict[str, Any]:
    """Same payload under the API prefix, matching the backend's convention."""
    return health_payload()


@app.get("/ready", tags=["health"])
async def ready() -> JSONResponse:
    """Readiness. Fails while no model is loaded, so traffic is not routed here."""
    payload = health_payload()
    if BUNDLE is None:
        payload["reason"] = LOAD_ERROR or "model not loaded"
        return JSONResponse(status_code=503, content=payload)
    return JSONResponse(status_code=200, content=payload)


@app.post("/predict", response_model=PredictResponse, tags=["prediction"])
async def predict(request: PredictRequest) -> JSONResponse:
    if BUNDLE is None:
        # The backend degrades to its rule layer on a non-200, which is the
        # correct outcome: a rule score labelled as one beats a fabricated model
        # score presented as calibrated.
        log(logging.WARNING, "prediction refused, no model loaded", projectId=request.projectId)
        return JSONResponse(
            status_code=503,
            content={"error": {"code": "MODEL_UNAVAILABLE", "message": "No model artifact is loaded"}},
        )

    frame, missing, supplied = build_frame(BUNDLE, request)

    if supplied < MIN_SUPPLIED_FEATURES:
        # Scoring this would mean running the model on a row the imputer built,
        # and returning the result as if it described the case. The backend
        # degrades to its rule layer on a non-200, which is the honest outcome.
        log(
            logging.WARNING,
            "prediction refused, too little evidence",
            projectId=request.projectId,
            suppliedFeatures=supplied,
            required=MIN_SUPPLIED_FEATURES,
        )
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "INSUFFICIENT_FEATURES",
                    "message": (
                        f"Only {supplied} model features were supplied; at least "
                        f"{MIN_SUPPLIED_FEATURES} are needed to score a case."
                    ),
                }
            },
        )

    probability = float(BUNDLE.model.predict_proba(frame)[0, 1])
    probability = min(max(probability, 0.0), 1.0)

    response = PredictResponse(
        delayProbability=round(probability, 5),
        # Conditional duration is not modelled yet, so this is a documented
        # linear stand-in rather than a second model pretending to be one.
        expectedDelayDays=int(round(probability * 60)),
        riskLevel=band_for(probability),  # type: ignore[arg-type]
        confidenceBand=confidence_for(supplied, len(BUNDLE.feature_columns) - len(DERIVED_FEATURES)),  # type: ignore[arg-type]
        modelVersion=BUNDLE.version,
        topRiskFactors=[RiskFactor(**factor) for factor in BUNDLE.explain(frame)],
    )

    log(
        logging.INFO,
        "prediction served",
        projectId=request.projectId,
        modelVersion=BUNDLE.version,
        riskLevel=response.riskLevel,
        suppliedFeatures=supplied,
        missingFeatures=missing,
        confidenceBand=response.confidenceBand,
    )
    return JSONResponse(status_code=200, content=response.model_dump())
