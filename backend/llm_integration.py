"""
Entry-point facade for the multi-provider LLM layer.

Use from application code:
    from llm_integration import run_llm_action, list_providers
"""

from llm.registry import get_provider, list_providers
from llm.service import run_llm_action

__all__ = ["get_provider", "list_providers", "run_llm_action"]
