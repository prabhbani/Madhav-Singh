#!/usr/bin/env python3
"""Validate the synthetic land-acquisition dataset contract and relationships."""

from __future__ import annotations

import csv
import math
import sys
from collections import Counter
from pathlib import Path


REQUIRED = {
    "data_origin", "case_id", "project_id", "as_of_date", "state", "district",
    "department", "project_size_area", "parcel_count", "affected_landowner_count",
    "objection_count", "missing_document_count", "pending_approval_count",
    "department_workload_index", "legal_dispute_flag", "overdue_days",
    "milestone_slippage_count", "significant_delay", "actual_delay_days", "risk_category",
}
OPTIONAL_MISSING = {"missing_optional_payment_history", "missing_optional_hearing_history"}
TARGETS = {"significant_delay", "actual_delay_days", "risk_category"}


def correlation(rows: list[dict[str, str]], left: str, right: str) -> float:
    a = [float(row[left]) for row in rows]
    b = [float(row[right]) for row in rows]
    mean_a, mean_b = sum(a) / len(a), sum(b) / len(b)
    variance_a = sum((value - mean_a) ** 2 for value in a)
    variance_b = sum((value - mean_b) ** 2 for value in b)
    return sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b)) / math.sqrt(variance_a * variance_b)


def validate(path: Path) -> None:
    with path.open(newline="", encoding="utf-8") as csv_file:
        rows = list(csv.DictReader(csv_file))
    if len(rows) < 5000:
        raise ValueError(f"expected at least 5,000 rows, found {len(rows)}")
    missing_columns = REQUIRED - set(rows[0])
    if missing_columns:
        raise ValueError(f"missing required columns: {sorted(missing_columns)}")
    if "synthetic_latent_probability_for_validation_only" in rows[0]:
        raise ValueError("target-derived latent probability must not be exported")
    case_ids = [row["case_id"] for row in rows]
    if len(set(case_ids)) != len(case_ids):
        raise ValueError("case_id values must be unique")
    if set(row["data_origin"] for row in rows) != {"SYNTHETIC"}:
        raise ValueError("every row must be explicitly marked SYNTHETIC")
    if any(not row["case_id"] or not row["project_id"] for row in rows):
        raise ValueError("identifiers cannot be blank")
    if any(row["significant_delay"] not in {"0", "1"} for row in rows):
        raise ValueError("significant_delay must be binary")
    if any(row["risk_category"] not in {"LOW", "MEDIUM", "HIGH", "CRITICAL"} for row in rows):
        raise ValueError("invalid risk category")
    numeric_nonnegative = [
        "project_size_area", "parcel_count", "affected_landowner_count", "objection_count",
        "missing_document_count", "pending_approval_count", "overdue_days",
        "milestone_slippage_count", "actual_delay_days",
    ]
    for field in numeric_nonnegative:
        if any(float(row[field]) < 0 for row in rows):
            raise ValueError(f"negative value in {field}")
    bounded = ["department_workload_index", "ownership_complexity_score", "document_completeness_ratio", "acquisition_complexity_score"]
    for field in bounded:
        if any(not 0 <= float(row[field]) <= 1 for row in rows):
            raise ValueError(f"out-of-range value in {field}")
    unexpected_missing = {
        field for field in rows[0]
        if any(row[field] == "" for row in rows)
    } - OPTIONAL_MISSING
    if unexpected_missing:
        raise ValueError(f"unexpected missing values in {sorted(unexpected_missing)}")
    if correlation(rows, "affected_landowner_count", "objection_count") < 0.45:
        raise ValueError("landowner/objection relationship is too weak")
    if correlation(rows, "missing_document_count", "milestone_slippage_count") < 0.20:
        raise ValueError("document/slippage relationship is too weak")
    if correlation(rows, "legal_dispute_flag", "actual_delay_days") < 0.05:
        raise ValueError("legal/delay relationship is too weak")
    delay_counts = Counter(row["significant_delay"] for row in rows)
    if min(delay_counts.values()) < len(rows) * 0.10:
        raise ValueError("delay target is too imbalanced for demonstration")
    print(f"PASS: {len(rows)} rows, {len(rows[0])} columns")
    print(f"Target distribution: {Counter(row['significant_delay'] for row in rows)}")
    print(f"Risk distribution: {Counter(row['risk_category'] for row in rows)}")
    print("Correlations:", {
        "landowners_objections": round(correlation(rows, "affected_landowner_count", "objection_count"), 3),
        "missing_documents_slippage": round(correlation(rows, "missing_document_count", "milestone_slippage_count"), 3),
        "legal_delay": round(correlation(rows, "legal_dispute_flag", "actual_delay_days"), 3),
    })


if __name__ == "__main__":
    validate(Path(sys.argv[1] if len(sys.argv) > 1 else "data/synthetic_land_acquisition_cases.csv"))