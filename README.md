# BurnSight AI — Burn-In Screening Intelligence

Problem Statement: 26170 — AI-Driven Anomaly Detection in Component Burn-In & Screening

## System overview

BurnSight is a local reliability analytics workspace for burn-in and environmental stress screening. It is designed around two core decision-support modules.

### Module A — Dynamic Anomaly Detection
- Robust batch-relative baseline using median/MAD.
- Trajectory features covering early slope, late slope, full-trajectory slope, growth ratio and endpoint deviation.
- Isolation Forest adds a multivariate shape-rarity signal.
- Adaptive safety slope is estimated from the healthy portion of the current batch.
- The fixed engineering limit is used as a safety gate, not as the only anomaly rule.

### Module B — 168h Drift Forecast
- Separate parameter-specific Random Forest regression models for Leakage Current, Iddq and Propagation Delay.
- Model inputs: Value_0h, Value_24h and derived early slope.
- Model target: Value_168h.
- Held-out MAE and R² are returned by the API and displayed in the application.
- Ensemble prediction spread is exposed as an uncertainty proxy.

## User workflow

1. Choose the parameter: Leakage Current, Iddq or Propagation Delay.
2. Load the included Reference Set or upload a CSV from a burn-in test system.
3. Review the behavioral envelope and component risk queue.
4. Open Component Inspector for evidence and forecast context.
5. Use Drift Forecast for an early 0h/24h prediction.
6. Use Scenario Lab for counterfactual threshold testing.
7. Generate the QA report.

## CSV contract

```csv
Component_ID,0h,24h,96h,168h
C001,10,11,12,13
C002,9,10,11,12
C003,11,15,25,43
```

The application analyzes one selected parameter at a time. The selected parameter controls its unit, engineering default, data interpretation and forecast model.

## Local setup — Windows

The included launcher will create a virtual environment, install dependencies and start the service.

```bat
run_windows.bat
```

Then open:

`http://127.0.0.1:8000`

Manual setup:

```bat
py -3.12 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python run.py
```

If Python 3.12 is not installed, install it from python.org or Windows Package Manager before running the launcher.

## Local setup — Linux/macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

## API

- `GET /api/health` — service and model health.
- `GET /api/metadata` — parameter and data contract.
- `GET /api/reference?parameter=leakage` — load the included reference batch.
- `POST /api/analyze` — analyze JSON rows.
- `POST /api/upload` — analyze a CSV upload.
- `POST /api/predict` — forecast Value_168h from Value_0h and Value_24h.
- `POST /api/what-if` — evaluate a custom 168h target.

## Data and validation note

The bundled Reference Sets and the model-training trajectories are deterministic generated data used for software verification. Production use requires controlled historical burn-in measurements, approved engineering limits, measurement traceability and qualified engineering review. The application is decision support; it does not replace a certified release procedure.
