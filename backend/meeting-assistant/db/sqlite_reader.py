from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Dict, List


class SQLiteTranscriptReader:
    def __init__(self, db_path: str, table: str = "transcripts") -> None:
        self.db_path = str(Path(db_path).resolve())
        self.table = table
        self.last_id = 0
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row

    def fetch_new_rows(self, limit: int = 1000) -> List[Dict[str, str]]:
        cur = self.conn.execute(
            f"""
            SELECT id, meeting_id, ts_iso, speaker, text
            FROM {self.table}
            WHERE id > ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (self.last_id, limit),
        )
        rows = cur.fetchall()
        if rows:
            self.last_id = int(rows[-1]["id"])
        return [
            {
                "id": int(r["id"]),
                "meeting_id": r["meeting_id"],
                "timestamp": r["ts_iso"],
                "speaker": r["speaker"],
                "text": r["text"],
            }
            for r in rows
        ]
