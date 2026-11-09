@echo off
rem Launch Discrete Viewer. Drag a .nc file onto this script, or run: discrete_viewer.bat model.nc
python "%~dp0discrete_viewer.py" %*
