#!/bin/sh
# Launch Discrete Viewer on Linux/macOS:  ./discrete_viewer.sh model.nc
exec python3 "$(dirname "$0")/discrete_viewer.py" "$@"
