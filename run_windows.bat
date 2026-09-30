@echo off
setlocal
cd /d "%~dp0"

echo.
echo ================================================
echo   BurnSight AI - Local Screening Platform
echo ================================================
echo.

if not exist .venv\Scripts\python.exe (
    echo Creating Python virtual environment...
    where py >nul 2>nul
    if %errorlevel%==0 (
        py -3.12 -m venv .venv
        if errorlevel 1 (
            echo Python 3.12 was not found.
            echo Install Python 3.12 and run this file again.
            pause
            exit /b 1
        )
    ) else (
        python -m venv .venv
        if errorlevel 1 (
            echo Python was not found on PATH.
            pause
            exit /b 1
        )
    )
)

call .venv\Scripts\activate
if errorlevel 1 (
    echo Could not activate the virtual environment.
    pause
    exit /b 1
)

python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    echo A supported Python version is required. Python 3.12 is recommended.
    pause
    exit /b 1
)

echo.
echo Starting BurnSight AI...
echo Open http://127.0.0.1:8000 in your browser.
echo Press Ctrl+C here to stop the server.
echo.
python run.py

endlocal
