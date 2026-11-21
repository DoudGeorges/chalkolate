"""Tests for backend configuration loading, defaults, redaction, and validation."""

from __future__ import annotations

import pytest

from config import ConfigurationError, load_settings


def test_defaults_redaction_and_validation() -> None:
    default_settings = load_settings(load_env_files=False, environ={})
    assert default_settings.gemini_model == "gemini-3.8-flash"
    assert default_settings.gemini_thinking_level == "low"
    assert default_settings.analysis_timeout_seconds == 20.0
    assert default_settings.max_model_long_edge == 1600
    assert default_settings.elevenlabs_model_id == "eleven_v4_turbo"
    assert default_settings.speech_configured is False

    minimal_settings = load_settings(
        load_env_files=False,
        environ={
            "GEMINI_THINKING_LEVEL": "  MINIMAL  ",
            "GEMINI_API_KEY": "super-secret-gemini",
            "ELEVENLABS_API_KEY": "super-secret-elevenlabs",
            "ELEVENLABS_VOICE_ID": "voice123",
        },
    )
    assert minimal_settings.gemini_thinking_level == "minimal"
    assert minimal_settings.analysis_configured is True
    assert minimal_settings.speech_configured is True

    # Neither API key ever appears in repr(settings)
    rendered = repr(minimal_settings)
    assert "super-secret-gemini" not in rendered
    assert "super-secret-elevenlabs" not in rendered

    # Incomplete ElevenLabs configuration keeps speech_configured=False
    missing_voice = load_settings(
        load_env_files=False,
        environ={"ELEVENLABS_API_KEY": "secret-key"},
    )
    assert missing_voice.speech_configured is False

    missing_key = load_settings(
        load_env_files=False,
        environ={"ELEVENLABS_VOICE_ID": "voice123"},
    )
    assert missing_key.speech_configured is False

    # Unknown / legacy environment keys (such as removed deep-mode settings) are safely ignored
    with_legacy = load_settings(
        load_env_files=False,
        environ={"GEMINI_DEEP_MODEL": "legacy", "GEMINI_THINKING_LEVEL": "high"},
    )
    assert with_legacy.gemini_thinking_level == "high"

    with pytest.raises(ConfigurationError):
        load_settings(load_env_files=False, environ={"GEMINI_THINKING_LEVEL": "ultra"})
    with pytest.raises(ConfigurationError):
        load_settings(load_env_files=False, environ={"SPEECH_TIMEOUT_SECONDS": "0"})
    with pytest.raises(ConfigurationError):
        load_settings(load_env_files=False, environ={"SPEECH_MAX_CONCURRENCY": "0"})
    with pytest.raises(ConfigurationError):
        load_settings(load_env_files=False, environ={"SPEECH_RATE_LIMIT_PER_MINUTE": "0"})
