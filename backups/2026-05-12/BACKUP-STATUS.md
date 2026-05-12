# GitHub Backup Status

Created: 2026-05-12 21:44:57
Type: Sanitized source backup split into base64 parts

Included:
- app.py
- ops_app/
- static/
- deploy/
- scripts/
- tests/*.py
- root startup scripts and docs

Excluded:
- .venv
- .codex-backups
- data/
- secrets and cookies
- logs and temp html/js
- generated sqlite test artifacts

Parts: 4
Restore: run restore-backup.ps1 in the same folder to rebuild the zip
