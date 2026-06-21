@echo off
REM Start a local web server and open the Collaboration Board hub.
cd /d "%~dp0"
set PORT=8000
echo Collaboration Board -^> http://localhost:%PORT%/index.html
echo (Close this window to stop the server)
start "" http://localhost:%PORT%/index.html
python -m http.server %PORT%
