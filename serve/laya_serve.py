"""Local laya-serve entry point shared by laya-router and laya-compaction.

Runs the official laya-serve app. When LAYA_CHECKPOINT names a fine-tuned
checkpoint directory, it replaces the built-in "multilingual" checkpoint, so
clients keep asking for "multilingual" and get the fine-tune.
"""
import os

import uvicorn
from laya.serve import build_router, create_app

os.environ["LAYA_PRELOAD"] = "0"
router = build_router()
checkpoint = os.environ.get("LAYA_CHECKPOINT", "").strip()
if checkpoint:
    router.register("multilingual", os.path.expanduser(checkpoint))
router.preload(["multilingual"])
uvicorn.run(
    create_app(router),
    host=os.environ.get("LAYA_HOST", "127.0.0.1"),
    port=int(os.environ.get("LAYA_PORT", "8765")),
    log_level=os.environ.get("LAYA_LOG_LEVEL", "warning"),
)
