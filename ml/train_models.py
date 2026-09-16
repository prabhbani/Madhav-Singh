#!/usr/bin/env python3
"""Train, compare, calibrate, and export delay-warning classifiers.

The script uses point-in-time predictors from the synthetic CSV. Target columns,
identifiers, provenance, and outcome-derived fields are explicitly excluded.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GridSearchCV, StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.inspection import permutation_importance

try:
    from xgboost import XGBClassifier
except Exception:
    XGBClassifier = None

try:
    from catboost import CatBoostClassifier
except Exception:
    CatBoostClassifier = None


RANDOM_STATE = 20260915
TARGET = "significant_delay"
TARGET_COLUMNS = {"significant_delay", "actual_delay_days", "risk_category"}
IDENTIFIER_COLUMNS = {"case_id", "project_id", "data_origin", "synthetic_scenario"}
DATE_COLUMN = "as_of_date"
FN_COST = 5.0
FP_COST = 1.0
MINIMUM_RECALL = 0.80


def make_one_hot_encoder() -> OneHotEncoder:
    try:
        return OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    except TypeError:
        return OneHotEncoder(handle_unknown="ignore", sparse=False)


def prepare_frame(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    parsed_dates = pd.to_datetime(result.pop(DATE_COLUMN), errors="coerce")
    result["snapshot_year"] = parsed_dates.dt.year
    result["snapshot_month"] = parsed_dates.dt.month
    result["snapshot_month_sin"] = np.sin(2 * np.pi * result["snapshot_month"] / 12)
    result["snapshot_month_cos"] = np.cos(2 * np.pi * result["snapshot_month"] / 12)
    return result


def build_preprocessor(features: pd.DataFrame) -> ColumnTransformer:
    numeric_columns = features.select_dtypes(include=["number", "bool"]).columns.tolist()
    categorical_columns = [column for column in features.columns if column not in numeric_columns]
    numeric_pipeline = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="median", add_indicator=True)),
            ("scale", StandardScaler()),
        ]
    )
    categorical_pipeline = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="most_frequent", add_indicator=True)),
            ("one_hot", make_one_hot_encoder()),
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("numeric", numeric_pipeline, numeric_columns),
            ("categorical", categorical_pipeline, categorical_columns),
        ],
        remainder="drop",
    )


def model_candidates() -> dict[str, tuple[Any, dict[str, list[Any]]]]:
    candidates: dict[str, tuple[Any, dict[str, list[Any]]]] = {
        "logistic_regression": (
            LogisticRegression(max_iter=1200, class_weight="balanced", random_state=RANDOM_STATE),
            {"model__C": [0.15, 0.5, 1.5, 4.0]},
        ),
        "random_forest": (
            RandomForestClassifier(
                n_estimators=240,
                class_weight="balanced",
                random_state=RANDOM_STATE,
                n_jobs=-1,
            ),
            {
                "model__max_depth": [None, 10, 18],
                "model__min_samples_leaf": [1, 3, 8],
            },
        ),
        "gradient_boosting": (
            GradientBoostingClassifier(random_state=RANDOM_STATE),
            {
                "model__n_estimators": [100, 180],
                "model__learning_rate": [0.04, 0.08],
                "model__max_depth": [2, 3],
            },
        ),
    }
    if XGBClassifier is not None:
        candidates["xgboost"] = (
            XGBClassifier(
                n_estimators=240,
                learning_rate=0.05,
                max_depth=4,
                subsample=0.85,
                colsample_bytree=0.85,
                objective="binary:logistic",
                eval_metric="logloss",
                random_state=RANDOM_STATE,
                n_jobs=-1,
            ),
            {
                "model__n_estimators": [160, 260],
                "model__max_depth": [3, 5],
                "model__learning_rate": [0.04, 0.08],
            },
        )
    if CatBoostClassifier is not None:
        candidates["catboost"] = (
            CatBoostClassifier(
                iterations=240,
                depth=5,
                learning_rate=0.06,
                loss_function="Logloss",
                verbose=False,
                random_seed=RANDOM_STATE,
                thread_count=-1,
            ),
            {
                "model__depth": [4, 6],
                "model__iterations": [160, 260],
            },
        )
    return candidates


def build_pipeline(model: Any, features: pd.DataFrame) -> Pipeline:
    return Pipeline(
        steps=[
            ("preprocess", build_preprocessor(features)),
            ("model", model),
        ]
    )


def calibrate_model(fitted_pipeline: Pipeline, x_train: pd.DataFrame, y_train: pd.Series) -> CalibratedClassifierCV:
    try:
        calibrated = CalibratedClassifierCV(fitted_pipeline, method="sigmoid", cv=3, n_jobs=-1)
    except TypeError:
        calibrated = CalibratedClassifierCV(base_estimator=fitted_pipeline, method="sigmoid", cv=3, n_jobs=-1)
    calibrated.fit(x_train, y_train)
    return calibrated


def expected_calibration_error(y_true: np.ndarray, probabilities: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0.0, 1.0, bins + 1)
    total_error = 0.0
    for lower, upper in zip(edges[:-1], edges[1:]):
        in_bin = (probabilities >= lower) & (probabilities < upper if upper < 1 else probabilities <= upper)
        if not np.any(in_bin):
            continue
        accuracy = np.mean(y_true[in_bin] == (probabilities[in_bin] >= 0.5))
        confidence = np.mean(probabilities[in_bin])
        total_error += np.sum(in_bin) / len(y_true) * abs(accuracy - confidence)
    return float(total_error)


def threshold_metrics(y_true: np.ndarray, probabilities: np.ndarray, threshold: float) -> dict[str, Any]:
    predictions = (probabilities >= threshold).astype(int)
    true_negative, false_positive, false_negative, true_positive = confusion_matrix(y_true, predictions, labels=[0, 1]).ravel()
    return {
        "threshold": round(float(threshold), 4),
        "accuracy": round(float(accuracy_score(y_true, predictions)), 6),
        "precision": round(float(precision_score(y_true, predictions, zero_division=0)), 6),
        "recall": round(float(recall_score(y_true, predictions, zero_division=0)), 6),
        "f1": round(float(f1_score(y_true, predictions, zero_division=0)), 6),
        "confusion_matrix": [[int(true_negative), int(false_positive)], [int(false_negative), int(true_positive)]],
        "false_positive_rate": round(float(false_positive / max(1, false_positive + true_negative)), 6),
        "false_negative_rate": round(float(false_negative / max(1, false_negative + true_positive)), 6),
        "false_negative_count": int(false_negative),
        "false_positive_count": int(false_positive),
        "operational_cost": round(float(FN_COST * false_negative + FP_COST * false_positive), 4),
    }


def select_operational_threshold(y_true: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    candidates = [round(value, 3) for value in np.linspace(0.05, 0.95, 181)]
    reports = [threshold_metrics(y_true, probabilities, threshold) for threshold in candidates]
    recall_qualified = [report for report in reports if report["recall"] >= MINIMUM_RECALL]
    pool = recall_qualified or reports
    return min(pool, key=lambda report: (report["operational_cost"], -report["recall"], report["threshold"]))


def probability_metrics(y_true: np.ndarray, probabilities: np.ndarray, threshold_report: dict[str, Any]) -> dict[str, Any]:
    calibration_fraction, calibration_mean = calibration_curve(y_true, probabilities, n_bins=10, strategy="quantile")
    return {
        **threshold_report,
        "roc_auc": round(float(roc_auc_score(y_true, probabilities)), 6),
        "pr_auc": round(float(average_precision_score(y_true, probabilities)), 6),
        "brier_score": round(float(brier_score_loss(y_true, probabilities)), 6),
        "log_loss": round(float(log_loss(y_true, probabilities)), 6),
        "expected_calibration_error": round(float(expected_calibration_error(y_true, probabilities)), 6),
        "calibration_curve": [
            {"mean_predicted_probability": round(float(predicted), 6), "observed_fraction": round(float(observed), 6)}
            for predicted, observed in zip(calibration_mean, calibration_fraction)
        ],
    }


def get_calibrated_base_model(calibrated: CalibratedClassifierCV) -> Pipeline:
    estimators = getattr(calibrated, "calibrated_classifiers_", [])
    if not estimators:
        raise RuntimeError("calibrated model has no fitted base estimators")
    base = getattr(estimators[0], "estimator", None) or getattr(estimators[0], "base_estimator", None)
    if base is None:
        raise RuntimeError("could not retrieve fitted base pipeline")
    return base


def explain_model(model_name: str, calibrated: CalibratedClassifierCV, x_test: pd.DataFrame, y_test: pd.Series, output_path: Path) -> None:
    base_pipeline = get_calibrated_base_model(calibrated)
    transformed = base_pipeline.named_steps["preprocess"].transform(x_test)
    model = base_pipeline.named_steps["model"]
    feature_names = base_pipeline.named_steps["preprocess"].get_feature_names_out().tolist()
    explanation: dict[str, Any] = {"method": "permutation_importance", "model": model_name, "factors": []}
    if model_name == "xgboost" and hasattr(model, "get_booster"):
        try:
            import xgboost as xgb

            contributions = model.get_booster().predict(xgb.DMatrix(transformed, feature_names=feature_names), pred_contribs=True)
            mean_signed = np.mean(contributions[:, :-1], axis=0)
            mean_absolute = np.mean(np.abs(contributions[:, :-1]), axis=0)
            explanation["method"] = "xgboost_native_shap_contributions"
            order = np.argsort(mean_absolute)[::-1][:25]
            explanation["factors"] = [
                {
                    "feature": feature_names[index],
                    "mean_abs_shap": round(float(mean_absolute[index]), 8),
                    "mean_signed_shap": round(float(mean_signed[index]), 8),
                    "rank": rank,
                }
                for rank, index in enumerate(order, start=1)
            ]
            output_path.write_text(json.dumps(explanation, indent=2), encoding="utf-8")
            return
        except Exception as error:
            explanation["fallback_reason"] = str(error)
    permutation = permutation_importance(
        calibrated,
        x_test,
        y_test,
        scoring="average_precision",
        n_repeats=5,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    order = np.argsort(permutation.importances_mean)[::-1][:25]
    explanation["factors"] = [
        {
            "feature": x_test.columns[index],
            "mean_importance": round(float(permutation.importances_mean[index]), 8),
            "importance_std": round(float(permutation.importances_std[index]), 8),
            "rank": rank,
        }
        for rank, index in enumerate(order, start=1)
    ]
    output_path.write_text(json.dumps(explanation, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/synthetic_land_acquisition_cases.csv"))
    parser.add_argument("--output-dir", type=Path, default=Path("ml/artifacts"))
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    frame = pd.read_csv(args.data)
    if len(frame) < 5000:
        raise ValueError("training dataset must contain at least 5,000 rows")
    forbidden = TARGET_COLUMNS | IDENTIFIER_COLUMNS
    features = prepare_frame(frame.drop(columns=list(TARGET_COLUMNS | IDENTIFIER_COLUMNS)))
    labels = frame[TARGET].astype(int)
    x_train, x_holdout, y_train, y_holdout = train_test_split(
        features, labels, test_size=0.30, random_state=RANDOM_STATE, stratify=labels
    )
    x_validation, x_test, y_validation, y_test = train_test_split(
        x_holdout, y_holdout, test_size=2 / 3, random_state=RANDOM_STATE, stratify=y_holdout
    )
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    candidates = model_candidates()
    comparison: dict[str, Any] = {}
    calibrated_models: dict[str, CalibratedClassifierCV] = {}
    validation_probabilities: dict[str, np.ndarray] = {}
    skipped: dict[str, str] = {}

    for model_name, (model, parameter_grid) in candidates.items():
        pipeline = build_pipeline(model, features)
        search = GridSearchCV(
            pipeline,
            param_grid=parameter_grid,
            scoring="average_precision",
            cv=cv,
            n_jobs=-1,
            refit=True,
        )
        search.fit(x_train, y_train)
        calibrated = calibrate_model(search.best_estimator_, x_train, y_train)
        validation_probabilities[model_name] = calibrated.predict_proba(x_validation)[:, 1]
        validation_threshold = select_operational_threshold(y_validation.to_numpy(), validation_probabilities[model_name])
        test_probabilities = calibrated.predict_proba(x_test)[:, 1]
        test_threshold = threshold_metrics(y_test.to_numpy(), test_probabilities, validation_threshold["threshold"])
        comparison[model_name] = {
            "best_params": search.best_params_,
            "cv_best_pr_auc": round(float(search.best_score_), 6),
            "validation": probability_metrics(y_validation.to_numpy(), validation_probabilities[model_name], validation_threshold),
            "test": probability_metrics(y_test.to_numpy(), test_probabilities, test_threshold),
            "threshold_selection": {
                "false_negative_cost": FN_COST,
                "false_positive_cost": FP_COST,
                "minimum_validation_recall": MINIMUM_RECALL,
                "selected_from": "validation_only",
            },
        }
        calibrated_models[model_name] = calibrated

    if CatBoostClassifier is None:
        skipped["catboost"] = "not installed; optional candidate was not run"
    if XGBClassifier is None:
        skipped["xgboost"] = "not installed; optional boosted candidate was not run"

    selected_name = max(
        comparison,
        key=lambda name: (
            comparison[name]["validation"]["recall"] >= MINIMUM_RECALL,
            comparison[name]["validation"]["pr_auc"],
            -comparison[name]["validation"]["operational_cost"],
            -comparison[name]["validation"]["brier_score"],
        ),
    )
    selected_model = calibrated_models[selected_name]
    model_version = f"synthetic-delay-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    model_dir = args.output_dir / model_version
    model_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(selected_model, model_dir / "model.joblib")
    base_pipeline = get_calibrated_base_model(selected_model)
    joblib.dump(base_pipeline.named_steps["preprocess"], model_dir / "preprocessing_pipeline.joblib")
    feature_metadata = {
        "feature_columns": features.columns.tolist(),
        "numeric_columns": features.select_dtypes(include=["number", "bool"]).columns.tolist(),
        "categorical_columns": [column for column in features.columns if column not in features.select_dtypes(include=["number", "bool"]).columns],
        "excluded_columns": sorted(forbidden),
        "target": TARGET,
        "random_state": RANDOM_STATE,
        "data_path": str(args.data),
    }
    (model_dir / "feature_metadata.json").write_text(json.dumps(feature_metadata, indent=2), encoding="utf-8")
    (model_dir / "evaluation_metrics.json").write_text(json.dumps(comparison, indent=2), encoding="utf-8")
    (model_dir / "skipped_models.json").write_text(json.dumps(skipped, indent=2), encoding="utf-8")
    explain_model(selected_name, selected_model, x_test, y_test, model_dir / "feature_importance_shap.json")
    metadata = {
        "model_version": model_version,
        "selected_model": selected_name,
        "selection_basis": "validation PR-AUC with recall floor, operational false-negative cost, and calibration",
        "training_rows": len(x_train),
        "validation_rows": len(x_validation),
        "test_rows": len(x_test),
        "target": TARGET,
        "false_negative_cost": FN_COST,
        "false_positive_cost": FP_COST,
        "minimum_recall": MINIMUM_RECALL,
        "python_version": platform.python_version(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (model_dir / "model_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    (args.output_dir / "latest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"model_version": model_version, "selected_model": selected_name, "artifacts": str(model_dir), "skipped": skipped}, indent=2))


if __name__ == "__main__":
    main()