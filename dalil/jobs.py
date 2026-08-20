"""
Dalīl — one long job at a time.

Harvesting is minutes of rate-limited requests and synchronous database work,
so it cannot run on the event loop and it must not run twice at once: two
harvests of the same query would race on the same cursor. One worker thread,
one lock, and a status a portal can poll.

Nothing here is a queue. If a job is running, a second request is told so and
declined — which is the honest answer, and keeps the failure mode "you have to
wait" rather than "two runs quietly corrupted each other".
"""
from __future__ import annotations

import datetime as dt
import threading
import traceback
from typing import Callable

now = dt.datetime.utcnow


class Jobs:
    def __init__(self, keep: int = 20):
        self._lock = threading.Lock()
        self.current: dict | None = None
        self.past: list = []
        self.keep = keep

    def start(self, name: str, fn: Callable[[], dict], detail: str = "") -> dict:
        with self._lock:
            if self.current is not None:
                return {"started": False, "busy": dict(self.current)}
            job = {"name": name, "detail": detail, "state": "running",
                   "started_at": now().isoformat(), "finished_at": None,
                   "result": None, "error": ""}
            self.current = job
        threading.Thread(target=self._run, args=(job, fn), daemon=True,
                         name=f"dalil-{name}").start()
        return {"started": True, "job": dict(job)}

    def _run(self, job: dict, fn: Callable[[], dict]) -> None:
        try:
            job["result"] = fn()
            job["state"] = "done"
        except Exception as e:                       # a failed job is data, not a crash
            job["state"] = "failed"
            job["error"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        finally:
            job["finished_at"] = now().isoformat()
            with self._lock:
                self.past.insert(0, job)
                del self.past[self.keep:]
                self.current = None

    def status(self) -> dict:
        with self._lock:
            return {"current": dict(self.current) if self.current else None,
                    "past": [dict(j) for j in self.past]}


jobs = Jobs()
