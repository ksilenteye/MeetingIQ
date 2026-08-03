"""
Test bootstrap.

The repo has two importable packages named `llm` (backend/llm and
backend/meeting-assistant/llm). Tests only touch the backend one, so backend/
is pinned ahead of meeting-assistant/ on sys.path. See CLAUDE.md.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
ASSISTANT = BACKEND / "meeting-assistant"

for entry in (str(ASSISTANT), str(BACKEND)):
    if entry in sys.path:
        sys.path.remove(entry)
    sys.path.insert(0, entry)


def _stub_missing(name: str, **attrs: object) -> None:
    """Provide a placeholder for an optional SDK that isn't installed.

    backend/llm/registry.py imports every provider at module scope, so the
    fallback paths under test can't be reached without these present. Nothing
    in the suite calls into them.
    """
    try:
        __import__(name)
        return
    except ImportError:
        pass
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    if "." in name:
        parent_name, _, child = name.rpartition(".")
        parent = sys.modules.get(parent_name) or types.ModuleType(parent_name)
        setattr(parent, child, module)
        sys.modules.setdefault(parent_name, parent)


_stub_missing("openai", OpenAI=object)
_stub_missing("google")
_stub_missing("google.generativeai")
