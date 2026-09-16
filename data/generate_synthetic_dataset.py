#!/usr/bin/env python3
"""Generate correlated synthetic land-acquisition cases for model development.

The generated CSV contains point-in-time predictor fields followed by outcome
labels. It is synthetic demonstration data and must not be presented as official
government statistics.
"""

from __future__ import annotations

import argparse
import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path


RNG_SEED = 20260915
DEFAULT_ROWS = 6000

STATES = {
    "Northland": ["Aster", "Birch", "Cedar"],
    "Eastland": ["Dawn", "Elm", "Frost"],
    "Southland": ["Grove", "Harbor", "Indigo"],
    "Westland": ["Juniper", "Kite", "Lumen"],
}
REGION_BY_STATE = {
    "Northland": "NORTH",
    "Eastland": "EAST",
    "Southland": "SOUTH",
    "Westland": "WEST",
}
DEPARTMENTS = [
    ("REVENUE", "Revenue and Land Records", 0.04),
    ("PUBLIC_WORKS", "Public Works", 0.08),
    ("TRANSPORT", "Transport Infrastructure", 0.02),
    ("IRRIGATION", "Water Resources", 0.06),
    ("URBAN", "Urban Development", 0.10),
]
PROJECT_TYPES = [
    ("ROAD", 1.00, 0.03),
    ("RAIL", 1.35, 0.07),
    ("IRRIGATION", 1.15, 0.05),
    ("INDUSTRIAL_CORRIDOR", 1.50, 0.10),
    ("URBAN_EXPANSION", 1.25, 0.08),
    ("POWER_TRANSMISSION", 0.90, 0.04),
]
LAND_USE = ["AGRICULTURAL", "RESIDENTIAL", "COMMERCIAL", "FOREST_EDGE", "MIXED"]
ACQUISITION_METHODS = ["DIRECT_PURCHASE", "STATUTORY", "CONSENT_BASED", "MIXED"]
START_DATE = date(2021, 1, 1)
END_DATE = date(2025, 12, 31)


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-clamp(value, -30.0, 30.0)))


def bounded_int(rng: random.Random, average: float, spread: float, minimum: int = 0) -> int:
    return max(minimum, int(round(rng.gauss(average, spread))))


def weighted_choice(rng: random.Random, values: list[str], weights: list[float]) -> str:
    return rng.choices(values, weights=weights, k=1)[0]


def make_catalog() -> tuple[list[dict[str, object]], dict[str, dict[str, object]]]:
    districts: list[dict[str, object]] = []
    for state, district_names in STATES.items():
        for index, district in enumerate(district_names, start=1):
            districts.append(
                {
                    "state": state,
                    "district": district,
                    "region": REGION_BY_STATE[state],
                    "urban_rural": "URBAN" if district in {"Dawn", "Harbor", "Aster", "Lumen"} else "RURAL",
                    "district_effect": [-0.20, 0.00, 0.18][index - 1],
                    "historical_delay_rate": [0.18, 0.30, 0.42][index - 1],
                }
            )
    workload_by_department = {
        code: 0.30 + index * 0.08 for index, (code, _name, _effect) in enumerate(DEPARTMENTS)
    }
    for district in districts:
        district["workload_index"] = clamp(
            workload_by_department["REVENUE"] + (0.12 if district["urban_rural"] == "URBAN" else -0.03),
            0.10,
            0.90,
        )
    return districts, {code: {"name": name, "effect": effect} for code, name, effect in DEPARTMENTS}


def generate_row(row_number: int, rng: random.Random, districts: list[dict[str, object]], departments: dict[str, dict[str, object]]) -> dict[str, object]:
    district = rng.choice(districts)
    department_code = weighted_choice(
        rng,
        list(departments),
        [0.23, 0.20, 0.18, 0.17, 0.22],
    )
    department = departments[department_code]
    project_type, type_complexity, type_effect = rng.choice(PROJECT_TYPES)
    project_priority = weighted_choice(rng, ["LOW", "MEDIUM", "HIGH", "CRITICAL"], [0.15, 0.53, 0.25, 0.07])
    land_use = weighted_choice(rng, LAND_USE, [0.42, 0.22, 0.12, 0.08, 0.16])

    as_of_date = START_DATE + timedelta(days=rng.randint(0, (END_DATE - START_DATE).days))
    project_size_area = clamp(rng.lognormvariate(math.log(92), 0.85), 4.0, 2600.0)
    area_per_parcel = clamp(rng.lognormvariate(math.log(1.9), 0.48), 0.25, 12.0)
    parcel_count = max(1, int(round(project_size_area / area_per_parcel + rng.gauss(0, 2.0))))
    affected_landowner_count = max(1, int(round(parcel_count * rng.lognormvariate(math.log(1.15), 0.40))))
    ownership_complexity = clamp(
        0.18 + 0.035 * min(affected_landowner_count, 30) + (0.13 if land_use == "RESIDENTIAL" else 0.0)
        + rng.gauss(0, 0.09),
        0.02,
        0.98,
    )
    disputed_ownership = rng.random() < clamp(0.04 + ownership_complexity * 0.34 + (0.08 if land_use == "MIXED" else 0), 0.03, 0.55)
    unresolved_records = max(0, int(round(rng.gauss(affected_landowner_count * (0.08 + ownership_complexity * 0.32), 1.2))))

    workload_index = clamp(
        float(district["workload_index"]) + float(department["effect"]) + rng.gauss(0, 0.09),
        0.05,
        0.98,
    )
    base_objection_rate = 0.035 + 0.16 * ownership_complexity + (0.06 if land_use in {"RESIDENTIAL", "MIXED"} else 0.0)
    objection_mean = affected_landowner_count * base_objection_rate
    objection_noise = max(2.5, math.sqrt(max(1.0, objection_mean)) * 1.8 + 2.5)
    objection_count = max(0, int(round(rng.gauss(objection_mean, objection_noise))))
    unresolved_objections = min(objection_count, max(0, int(round(objection_count * (0.50 + workload_index * 0.32 + rng.gauss(0, 0.10))))))

    required_documents = max(5, int(round(4 + parcel_count * 0.55 + affected_landowner_count * 0.15)))
    document_difficulty = clamp(0.12 + ownership_complexity * 0.35 + workload_index * 0.17 + rng.gauss(0, 0.08), 0.02, 0.90)
    missing_documents = max(0, int(round(rng.gauss(required_documents * document_difficulty * 0.22, 1.5))))
    invalid_documents = max(0, int(round(rng.gauss(missing_documents * (0.22 + document_difficulty * 0.25), 0.7))))
    verification_pending = max(0, min(required_documents, int(round(rng.gauss((missing_documents + invalid_documents) * 0.65, 1.0)))))
    document_completeness = clamp(1.0 - (missing_documents + invalid_documents * 0.7) / required_documents, 0.20, 1.0)

    approval_stages = max(2, int(round(3 + type_complexity + (1 if project_priority in {"HIGH", "CRITICAL"} else 0))))
    pending_approvals = max(0, int(round(rng.gauss((approval_stages - 1) * (0.18 + workload_index * 0.35), 0.7))))
    interdepartment_dependencies = max(
        0,
        int(round(rng.gauss(
            1.2 + (2.0 if project_type in {"RAIL", "INDUSTRIAL_CORRIDOR"} else 0.0),
            1.0,
        ))),
    )
    dependency_blocked = max(0, min(interdepartment_dependencies, int(round(rng.gauss(interdepartment_dependencies * (0.20 + workload_index * 0.35), 0.7)))))

    legal_probability = clamp(0.015 + disputed_ownership * 0.16 + unresolved_objections * 0.014 + ownership_complexity * 0.12, 0.01, 0.62)
    legal_dispute = rng.random() < legal_probability
    stay_order = legal_dispute and rng.random() < clamp(0.08 + unresolved_objections * 0.018, 0.05, 0.38)
    court_case_count = (1 if legal_dispute else 0) + (1 if legal_dispute and rng.random() < 0.18 else 0)
    hearing_count = max(0, int(round(rng.gauss(unresolved_objections * 0.35 + (1.5 if legal_dispute else 0), 0.8))))

    compensation_rate = {"AGRICULTURAL": 1.0, "RESIDENTIAL": 2.4, "COMMERCIAL": 3.8, "FOREST_EDGE": 1.4, "MIXED": 2.1}[land_use]
    compensation_amount = max(50000.0, project_size_area * compensation_rate * rng.lognormvariate(math.log(185000), 0.30))
    compensation_approved = rng.random() < clamp(0.83 - pending_approvals * 0.07 - workload_index * 0.16, 0.20, 0.94)
    approved_amount = compensation_amount * rng.uniform(0.82, 1.02) if compensation_approved else 0.0
    payment_pending = max(0.0, approved_amount * clamp(rng.gauss(0.28 + workload_index * 0.26 + (0.15 if legal_dispute else 0), 0.14), 0.0, 1.0))
    payment_processing_days = max(4, int(round(rng.gauss(28 + workload_index * 35 + (18 if legal_dispute else 0), 9))))

    stage_baseline_days = {
        "ROAD": 86, "RAIL": 132, "IRRIGATION": 104, "INDUSTRIAL_CORRIDOR": 158,
        "URBAN_EXPANSION": 118, "POWER_TRANSMISSION": 74,
    }[project_type]
    historical_department_delay_rate = clamp(float(department["effect"]) + 0.28 + rng.gauss(0, 0.045), 0.08, 0.72)
    historical_district_delay_rate = clamp(float(district["historical_delay_rate"]) + rng.gauss(0, 0.035), 0.08, 0.72)
    stage_duration = max(
        12,
        int(round(rng.gauss(
            stage_baseline_days * (0.52 + type_complexity * 0.22)
            + unresolved_records * 2.1
            + missing_documents * 1.6
            + unresolved_objections * 1.4
            + pending_approvals * 8.0
            + dependency_blocked * 9.0
            + workload_index * 38
            + (34 if legal_dispute else 0)
            + (64 if stay_order else 0),
            15 + stage_baseline_days * 0.14,
        ))),
    )
    days_in_current_stage = max(1, int(round(stage_duration * rng.uniform(0.25, 0.92))))
    overdue_days = max(0, int(round(days_in_current_stage - stage_baseline_days * 0.72 + rng.gauss(0, 8))))
    milestone_slippage_count = max(0, int(round(rng.gauss(
        overdue_days / 48 + pending_approvals * 0.55 + missing_documents * 0.08 + dependency_blocked * 0.45,
        0.9,
    ))))
    average_stage_duration = max(20, int(round(rng.gauss(stage_baseline_days * (0.72 + workload_index * 0.32), 15))))
    days_since_update = max(0, int(round(rng.gauss(8 + workload_index * 18 + overdue_days * 0.10, 5))))

    urgency = {"LOW": -0.18, "MEDIUM": 0.0, "HIGH": 0.12, "CRITICAL": 0.25}[project_priority]
    latent_risk = (
        -7.15
        + 0.00035 * min(project_size_area, 1200)
        + 0.018 * min(parcel_count, 100)
        + 0.018 * min(affected_landowner_count, 120)
        + 1.10 * ownership_complexity
        + 0.055 * min(unresolved_records, 25)
        + 0.045 * min(unresolved_objections, 30)
        + 0.12 * min(missing_documents, 24)
        + 0.10 * min(invalid_documents, 12)
        + 0.14 * min(pending_approvals, 8)
        + 0.18 * min(dependency_blocked, 6)
        + 0.009 * min(overdue_days, 180)
        + 0.13 * min(milestone_slippage_count, 8)
        + 0.0020 * payment_processing_days
        + 0.000000001 * payment_pending
        + 0.88 * legal_dispute
        + 0.82 * stay_order
        + 1.25 * float(district["district_effect"])
        + 1.1 * historical_department_delay_rate
        + 0.65 * historical_district_delay_rate
        + 0.52 * workload_index
        + type_effect
        + urgency
        + rng.gauss(0, 0.52)
    )
    delay_probability = clamp(sigmoid(latent_risk), 0.015, 0.985)
    significant_delay = rng.random() < delay_probability
    if significant_delay:
        expected_delay_days = max(8, int(round(rng.gammavariate(2.8, 12 + 20 * delay_probability) + overdue_days * 0.45 + (35 if stay_order else 0))))
    else:
        expected_delay_days = max(0, int(round(rng.gauss(3 + overdue_days * 0.08, 5))))
    actual_delay_days = expected_delay_days + (rng.randint(-12, 14) if expected_delay_days > 0 else 0)
    actual_delay_days = max(0, actual_delay_days)
    if significant_delay and actual_delay_days < 30:
        actual_delay_days += rng.randint(8, 28)
    if not significant_delay and actual_delay_days >= 30:
        actual_delay_days = rng.randint(0, 24)

    hard_critical = stay_order or (overdue_days >= 120 and legal_dispute)
    if hard_critical or delay_probability >= 0.78:
        risk_category = "CRITICAL"
    elif delay_probability >= 0.55:
        risk_category = "HIGH"
    elif delay_probability >= 0.30:
        risk_category = "MEDIUM"
    else:
        risk_category = "LOW"

    missingness = rng.random()
    def maybe_missing(value: object, probability: float = 0.0) -> object:
        return None if missingness < probability else value

    return {
        "data_origin": "SYNTHETIC",
        "synthetic_scenario": "CORRELATED_WORKFLOW_SIMULATION",
        "case_id": f"SYN-CASE-{row_number:06d}",
        "project_id": f"SYN-PROJECT-{(row_number - 1) // 3 + 1:05d}",
        "as_of_date": as_of_date.isoformat(),
        "state": district["state"],
        "district": district["district"],
        "region": district["region"],
        "urban_rural": district["urban_rural"],
        "department": department_code,
        "project_type": project_type,
        "acquisition_method": weighted_choice(rng, ACQUISITION_METHODS, [0.34, 0.33, 0.17, 0.16]),
        "project_priority": project_priority,
        "land_use_category": land_use,
        "project_size_area": round(project_size_area, 3),
        "parcel_count": parcel_count,
        "affected_landowner_count": affected_landowner_count,
        "ownership_complexity_score": round(ownership_complexity, 4),
        "disputed_ownership_flag": int(disputed_ownership),
        "unresolved_record_count": unresolved_records,
        "objection_count": objection_count,
        "unresolved_objection_count": unresolved_objections,
        "required_document_count": required_documents,
        "missing_document_count": missing_documents,
        "invalid_document_count": invalid_documents,
        "document_verification_pending_count": verification_pending,
        "document_completeness_ratio": round(document_completeness, 4),
        "approval_stage_count": approval_stages,
        "pending_approval_count": pending_approvals,
        "interdepartment_dependency_count": interdepartment_dependencies,
        "blocked_dependency_count": dependency_blocked,
        "assessed_compensation_amount": round(compensation_amount, 2),
        "approved_compensation_amount": round(approved_amount, 2),
        "pending_compensation_amount": round(payment_pending, 2),
        "compensation_approval_pending_flag": int(not compensation_approved),
        "payment_processing_days": payment_processing_days,
        "open_legal_case_count": court_case_count,
        "legal_dispute_flag": int(legal_dispute),
        "stay_order_flag": int(stay_order),
        "hearing_count": hearing_count,
        "current_stage": weighted_choice(rng, ["SURVEY", "NOTICE", "OBJECTION_REVIEW", "COMPENSATION", "AWARD", "PAYMENT"], [0.10, 0.14, 0.20, 0.24, 0.16, 0.16]),
        "days_in_current_stage": days_in_current_stage,
        "overdue_days": overdue_days,
        "average_stage_duration_days": average_stage_duration,
        "historical_department_delay_rate": round(historical_department_delay_rate, 4),
        "historical_district_delay_rate": round(historical_district_delay_rate, 4),
        "department_workload_index": round(workload_index, 4),
        "milestone_slippage_count": milestone_slippage_count,
        "days_since_last_update": days_since_update,
        "acquisition_complexity_score": round(clamp(0.24 * ownership_complexity + 0.18 * min(parcel_count / 80, 1) + 0.20 * min(objection_count / 20, 1) + 0.20 * document_difficulty + 0.18 * min(dependency_blocked / 5, 1), 0, 1), 4),
        "prediction_horizon_days": 90,
        "significant_delay": int(significant_delay),
        "actual_delay_days": actual_delay_days,
        "risk_category": risk_category,
        "missing_optional_payment_history": maybe_missing(0, 0.035),
        "missing_optional_hearing_history": maybe_missing(0, 0.025),
    }


def write_dataset(output_path: Path, rows: int, seed: int) -> None:
    rng = random.Random(seed)
    districts, departments = make_catalog()
    generated = [generate_row(index, rng, districts, departments) for index in range(1, rows + 1)]
    fieldnames = list(generated[0])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(generated)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--seed", type=int, default=RNG_SEED)
    parser.add_argument("--output", type=Path, default=Path("data/synthetic_land_acquisition_cases.csv"))
    args = parser.parse_args()
    if args.rows < 5000:
        parser.error("--rows must be at least 5000")
    write_dataset(args.output, args.rows, args.seed)
    print(f"Wrote {args.rows} SYNTHETIC records to {args.output}")


if __name__ == "__main__":
    main()