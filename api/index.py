"""Vercel entrypoint: serves the FastAPI app from ``server/`` under ``/api/*``.

Only this file lives in ``api/`` because Vercel turns every ``.py`` file in that
directory into its own function. The application modules live in ``server/``.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from main import app

__all__ = ["app"]
