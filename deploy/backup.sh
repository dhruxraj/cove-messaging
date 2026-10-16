#!/bin/sh
# Database dump + media archive. Run by the `backup` compose service once a day.
# Restore: see docs/DEPLOYMENT.md ("Backups and restore").
set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir=/backups
mkdir -p "$dir"

pg_dump --format=custom --no-owner --file="$dir/cove-db-$stamp.dump"
# Media files are opaque blobs named by random ids; the database maps them to messages.
tar -C /data -czf "$dir/cove-media-$stamp.tar.gz" storage/objects 2>/dev/null || true

find "$dir" -name 'cove-*' -type f -mtime +"${KEEP_DAYS:-14}" -delete
echo "backup $stamp done"
