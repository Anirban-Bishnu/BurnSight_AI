from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sklearn.ensemble import IsolationForest, RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
import pandas as pd
import numpy as np
from pathlib import Path
import io
import datetime
import math

BASE = Path(__file__).resolve().parent.parent
STATIC = BASE / "static"
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)

app = FastAPI(
    title="BurnSight AI — Burn-In Screening Intelligence",
    version="3.0.0",
    description="Local reliability analytics for burn-in and environmental stress screening."
)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

PARAMS = {
    "leakage": {
        "label": "Leakage Current",
        "unit": "µA",
        "limit": 50.0,
        "decimals": 3,
        "description": "Junction / leakage current monitored across burn-in checkpoints.",
    },
    "iddq": {
        "label": "Standby Current (Iddq)",
        "unit": "µA",
        "limit": 20.0,
        "decimals": 3,
        "description": "Quiescent supply current measured at defined screening checkpoints.",
    },
    "delay": {
        "label": "Propagation Delay",
        "unit": "ns",
        "limit": 50.0,
        "decimals": 3,
        "description": "Signal propagation delay monitored for latent timing drift.",
    },
}
TIMES = [0, 24, 96, 168]
COLS = ["0h", "24h", "96h", "168h"]


class AnalyzeRequest(BaseModel):
    parameter: str = "leakage"
    rows: list[dict]
    max_limit: float | None = None
    batch_id: str = "BATCH-LOCAL-001"


class PredictRequest(BaseModel):
    parameter: str = "leakage"
    values: list[float] = Field(min_length=2, max_length=2)


class WhatIfRequest(PredictRequest):
    target_168h: float | None = None


MODELS = {}


def parameter_profile(parameter: str):
    return {
        "leakage": (10.0, 0.75, 0.012, 0.0040, 0.14),
        "iddq": (3.0, 0.22, 0.009, 0.0030, 0.05),
        "delay": (8.0, 0.48, 0.006, 0.0025, 0.07),
    }[parameter]


def generate_training_data(parameter: str, n: int = 4200, seed: int = 17):
    """Create deterministic reference trajectories for software verification."""
    rng = np.random.default_rng(seed + list(PARAMS).index(parameter))
    base_mu, base_sd, drift_mu, drift_sd, noise = parameter_profile(parameter)
    x0 = np.clip(rng.normal(base_mu, base_sd, n), base_mu * 0.35, None)
    drift = np.clip(rng.normal(drift_mu, drift_sd, n), 0.001, 0.04)
    curvature = rng.normal(0.0, 0.00004, n)
    x24 = x0 * (1 + drift) + rng.normal(0, noise, n)
    x96 = x0 * (1 + drift * 4.0 + curvature * 96) + rng.normal(0, noise * 1.5, n)
    x168 = x0 * (1 + drift * 7.0 + curvature * 168) + rng.normal(0, noise * 2.0, n)
    X = np.column_stack([x0, x24, (x24 - x0) / 24.0])
    y = np.maximum(x168, 0.01)
    return X, y


def train_model(parameter: str):
    X, y = generate_training_data(parameter)
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.20, random_state=42)
    model = RandomForestRegressor(
        n_estimators=220,
        max_depth=12,
        min_samples_leaf=4,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(Xtr, ytr)
    pred = model.predict(Xte)
    return model, {
        "mae": float(mean_absolute_error(yte, pred)),
        "r2": float(r2_score(yte, pred)),
        "train_samples": len(Xtr),
        "test_samples": len(Xte),
        "algorithm": "Random Forest Regression",
        "features": ["Value_0h", "Value_24h", "Early_Slope"],
        "target": "Value_168h",
    }


for _parameter in PARAMS:
    MODELS[_parameter] = train_model(_parameter)


def reference_rows(parameter: str = "leakage", n: int = 120):
    rng = np.random.default_rng(2026 + list(PARAMS).index(parameter))
    base_mu, base_sd, drift_mu, drift_sd, noise = parameter_profile(parameter)
    rows = []
    for i in range(n):
        base = max(base_mu * 0.55, rng.normal(base_mu, base_sd))
        drift = max(0.001, rng.normal(drift_mu, drift_sd))
        curvature = rng.normal(0, 0.00004)
        values = [
            base * (1 + drift * t / 24 + curvature * t) + rng.normal(0, noise)
            for t in TIMES
        ]
        rows.append(
            {
                "Component_ID": f"C{i + 1:03d}",
                "0h": round(max(values[0], 0.001), 4),
                "24h": round(max(values[1], 0.001), 4),
                "96h": round(max(values[2], 0.001), 4),
                "168h": round(max(values[3], 0.001), 4),
            }
        )

    # A small set of latent-defect signatures: early rise is noticeable, but the
    # measurements remain below the fixed limit until the trajectory separates.
    signatures = [
        (7, 1.52, 1.25, 1.23),
        (28, 1.42, 1.32, 1.28),
        (64, 1.66, 1.25, 1.20),
        (91, 1.47, 1.36, 1.23),
        (103, 1.38, 1.32, 1.25),
    ]
    for idx, early_mult, mid_mult, late_mult in signatures:
        r = rows[idx]
        r["24h"] = round(r["0h"] * early_mult, 4)
        r["96h"] = round(r["24h"] * mid_mult, 4)
        r["168h"] = round(r["96h"] * late_mult, 4)
    return rows


def clean_df(rows):
    df = pd.DataFrame(rows)
    required = {"Component_ID", *COLS}
    if not required.issubset(df.columns):
        raise ValueError("CSV must contain Component_ID, 0h, 24h, 96h and 168h columns.")
    df = df[["Component_ID"] + COLS].copy()
    df["Component_ID"] = df["Component_ID"].astype(str).str.strip()
    for column in COLS:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df.replace([np.inf, -np.inf], np.nan).dropna().copy()
    df = df[df["Component_ID"].ne("")]
    if len(df) < 8:
        raise ValueError("Need at least 8 valid components for batch-relative screening.")
    if df["Component_ID"].duplicated().any():
        raise ValueError("Component_ID values must be unique.")
    if (df[COLS] < 0).any().any():
        raise ValueError("Measurements cannot be negative.")
    return df.reset_index(drop=True)


def robust_z(values):
    median = np.median(values, axis=0)
    mad = np.median(np.abs(values - median), axis=0)
    fallback = np.std(values, axis=0)
    mad = np.where(mad < 1e-9, fallback + 1e-9, mad)
    return 0.6745 * (values - median) / mad, median, mad


def sigmoid(value):
    return 1.0 / (1.0 + math.exp(-float(np.clip(value, -30, 30))))


def percentile_rank(values):
    order = np.argsort(values)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(len(values), dtype=float)
    return ranks / max(len(values) - 1, 1)


def estimate_crossing_hours(start_value: float, slope: float, target: float):
    if slope <= 0 or start_value >= target:
        return None
    hours = (target - start_value) / slope
    return float(hours) if 0 < hours <= 168 else None


def analyze(df, parameter="leakage", max_limit=None):
    if parameter not in PARAMS:
        raise ValueError("Unknown parameter")

    x = df[COLS].to_numpy(float)
    rz, median, mad = robust_z(x)
    abs_rz = np.abs(rz)
    endpoint_z = abs_rz[:, -1]
    max_z = np.max(abs_rz, axis=1)

    early_slope = (x[:, 1] - x[:, 0]) / 24.0
    late_slope = (x[:, 3] - x[:, 2]) / 72.0
    full_slope = (x[:, 3] - x[:, 0]) / 168.0
    growth_ratio = (x[:, 3] - x[:, 0]) / np.maximum(x[:, 0], 1e-9)
    late_abs = np.abs(late_slope)
    healthy_reference = np.median(late_abs) + 1e-9
    slope_ratio = late_abs / healthy_reference

    features = np.column_stack([
        x,
        early_slope,
        late_slope,
        full_slope,
        growth_ratio,
        max_z,
    ])
    iso = IsolationForest(
        n_estimators=300,
        contamination=min(0.10, max(0.04, 6 / len(df))),
        random_state=42,
    )
    iso.fit(features)
    iso_raw = -iso.decision_function(features)
    iso_rank = percentile_rank(iso_raw)

    # Percentile signals keep the index relative to the current batch and avoid
    # artificial saturation where several extreme parts would all display 100%.
    max_rank = percentile_rank(max_z)
    endpoint_rank = percentile_rank(endpoint_z)
    trajectory_rank = percentile_rank(slope_ratio)
    rise_rank = percentile_rank(growth_ratio)
    batch_signal = max_rank
    endpoint_signal = endpoint_rank
    trajectory_signal = trajectory_rank
    rise_signal = rise_rank

    raw_score = (
        0.36 * batch_signal
        + 0.25 * endpoint_signal
        + 0.22 * trajectory_signal
        + 0.10 * rise_signal
        + 0.07 * iso_rank
    )

    healthy = np.argsort(raw_score)[: max(5, int(len(df) * 0.62))]
    baseline_slope = float(np.median(np.abs(full_slope[healthy])))
    p80_slope = float(np.percentile(np.abs(full_slope[healthy]), 80))
    safety_slope = max(baseline_slope * 2.6, p80_slope * 1.65, 1e-8)

    abs_limit = PARAMS[parameter]["limit"] if max_limit is None else float(max_limit)
    abs_fail = x[:, -1] > abs_limit

    rows = []
    for i, record in df.iterrows():
        reasons = []
        if endpoint_z[i] > 2.8:
            reasons.append("168h measurement is materially outside the batch baseline")
        if abs(late_slope[i]) > safety_slope:
            reasons.append("late-stage drift exceeds the adaptive safety slope")
        if growth_ratio[i] > 0.45:
            reasons.append("end-to-end increase is unusually steep")
        if iso_rank[i] >= 0.90:
            reasons.append("trajectory shape is rare within the batch")
        if abs_fail[i]:
            reasons.append("absolute engineering limit exceeded")
        if not reasons:
            reasons.append("trajectory remains inside the observed behavioral envelope")

        score = float(np.clip(100.0 * (0.06 + 0.92 * raw_score[i]), 0, 98.9))
        if abs_fail[i]:
            score = max(score, 99.2)

        status = "HIGH RISK" if (score >= 90 or abs_fail[i]) else ("WATCH" if score >= 72 else "NORMAL")
        crossing = estimate_crossing_hours(float(x[i, 0]), float(full_slope[i]), abs_limit)
        rows.append({
            "id": record["Component_ID"],
            "values": [float(record[c]) for c in COLS],
            "score": round(score, 1),
            "status": status,
            "slope": float(full_slope[i]),
            "early_slope": float(early_slope[i]),
            "late_slope": float(late_slope[i]),
            "growth_ratio": float(growth_ratio[i]),
            "endpoint_z": float(endpoint_z[i]),
            "percentile": float(percentile_rank(max_z)[i] * 100),
            "lead_time_hours": crossing,
            "reasons": reasons,
            "signals": {
                "batch_deviation": round(float(batch_signal[i] * 100), 1),
                "endpoint_deviation": round(float(endpoint_signal[i] * 100), 1),
                "trajectory_drift": round(float(trajectory_signal[i] * 100), 1),
                "shape_rarity": round(float(iso_rank[i] * 100), 1),
            },
        })

    rows.sort(key=lambda item: item["score"], reverse=True)
    status_counts = pd.Series([r["status"] for r in rows]).value_counts().to_dict()
    envelope_low = np.percentile(x, 10, axis=0)
    envelope_high = np.percentile(x, 90, axis=0)
    envelope_median = np.median(x, axis=0)

    return rows, {
        "batch_median": [float(v) for v in envelope_median],
        "batch_mad": [float(v) for v in mad],
        "envelope_p10": [float(v) for v in envelope_low],
        "envelope_p90": [float(v) for v in envelope_high],
        "safety_slope": safety_slope,
        "baseline_slope": baseline_slope,
        "absolute_limit": abs_limit,
        "screening_method": "Robust median/MAD + trajectory signals + Isolation Forest",
        "healthy_reference_fraction": 0.62,
        "scoring": "Batch deviation 36% · endpoint 25% · trajectory 22% · growth 10% · shape rarity 7%",
    }


def predict(parameter, values):
    if parameter not in PARAMS:
        raise ValueError("Unknown parameter")
    if len(values) != 2:
        raise ValueError("Provide exactly Value_0h and Value_24h.")
    v = np.array(values, dtype=float)
    if np.any(~np.isfinite(v)) or np.any(v < 0):
        raise ValueError("Measurements must be finite and non-negative.")

    X = np.array([[v[0], v[1], (v[1] - v[0]) / 24.0]])
    model, metrics = MODELS[parameter]
    prediction = float(max(0, model.predict(X)[0]))
    ensemble = np.array([est.predict(X)[0] for est in model.estimators_])
    uncertainty = float(np.std(ensemble))
    return prediction, uncertainty, metrics


def package(rows, meta, parameter, batch_id="BATCH-LOCAL-001"):
    counts = pd.Series([r["status"] for r in rows]).value_counts().to_dict()
    return {
        "parameter": parameter,
        "parameter_meta": PARAMS[parameter],
        "batch_id": batch_id,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "summary": {
            "total": len(rows),
            "normal": int(counts.get("NORMAL", 0)),
            "watch": int(counts.get("WATCH", 0)),
            "high_risk": int(counts.get("HIGH RISK", 0)),
        },
        "meta": meta,
        "rows": rows,
        "top_risks": rows[:8],
        "model": MODELS[parameter][1],
    }


@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "BurnSight AI",
        "version": "3.0.0",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "models": {p: MODELS[p][1] for p in PARAMS},
    }


@app.get("/api/metadata")
def metadata():
    return {
        "parameters": PARAMS,
        "timepoints": TIMES,
        "required_columns": ["Component_ID"] + COLS,
        "modules": [
            "Dynamic Anomaly Detection",
            "168h Drift Prediction",
            "Explainability",
            "Scenario Analysis",
        ],
    }


@app.get("/api/reference")
def reference(parameter: str = Query("leakage"), batch_id: str = "BATCH-REFERENCE-01"):
    try:
        df = clean_df(reference_rows(parameter))
        rows, meta = analyze(df, parameter)
        return package(rows, meta, parameter, batch_id=batch_id)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/analyze")
def api_analyze(req: AnalyzeRequest):
    try:
        df = clean_df(req.rows)
        rows, meta = analyze(df, req.parameter, req.max_limit)
        return package(rows, meta, req.parameter, batch_id=req.batch_id)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/upload")
async def upload(
    file: UploadFile = File(...),
    parameter: str = "leakage",
    max_limit: float | None = None,
    batch_id: str = "BATCH-UPLOAD-001",
):
    try:
        raw = await file.read()
        df = clean_df(pd.read_csv(io.BytesIO(raw)))
        rows, meta = analyze(df, parameter, max_limit)
        return package(rows, meta, parameter, batch_id=batch_id)
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/predict")
def api_predict(req: PredictRequest):
    try:
        prediction, uncertainty, metrics = predict(req.parameter, req.values)
        limit = PARAMS[req.parameter]["limit"]
        risk = "HIGH" if prediction > limit else ("WATCH" if prediction > limit * 0.85 else "CONTROLLED")
        return {
            "parameter": req.parameter,
            "predicted_168h": round(prediction, 4),
            "uncertainty": round(uncertainty, 4),
            "input_values": req.values,
            "early_slope": round((req.values[1] - req.values[0]) / 24.0, 6),
            "risk": risk,
            "engineering_limit": limit,
            "model_metrics": metrics,
            "model_type": "Parameter-specific Random Forest Regression",
        }
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/what-if")
def what_if(req: WhatIfRequest):
    try:
        prediction, uncertainty, metrics = predict(req.parameter, req.values)
        target = float(req.target_168h) if req.target_168h is not None else PARAMS[req.parameter]["limit"]
        if target <= 0:
            raise ValueError("Safety target must be greater than zero.")
        margin = target - prediction
        risk = "HIGH" if prediction > target else ("WATCH" if prediction > target * 0.85 else "CONTROLLED")
        crossing = estimate_crossing_hours(float(req.values[0]), float((req.values[1] - req.values[0]) / 24.0), target)
        return {
            "parameter": req.parameter,
            "predicted_168h": round(prediction, 4),
            "target": round(target, 4),
            "margin": round(margin, 4),
            "risk": risk,
            "uncertainty": round(uncertainty, 4),
            "early_slope": round((req.values[1] - req.values[0]) / 24.0, 6),
            "estimated_crossing_hours": round(crossing, 2) if crossing is not None else None,
            "model_metrics": metrics,
        }
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
