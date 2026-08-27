from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from fju_outline.artifacts import (
    EMBEDDING_GEMMA_DOCUMENT_PROMPT,
    EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
    EMBEDDING_GEMMA_MODEL,
    EMBEDDING_GEMMA_QUERY_PROMPT,
    EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
    EMBEDDING_GEMMA_REVISION,
    EmbeddingGemmaEncoder,
    _select_embedding_device,
    validate_artifacts,
)


class _FakeTorch:
    float32 = object()

    def __init__(self, available: bool = False):
        self.cuda = SimpleNamespace(is_available=lambda: available)
        self.thread_count = None
        self.interop_thread_count = None

    def set_num_threads(self, value: int):
        self.thread_count = value

    def set_num_interop_threads(self, value: int):
        self.interop_thread_count = value


class _FakeModel:
    def __init__(self):
        config = SimpleNamespace(_commit_hash=EMBEDDING_GEMMA_REVISION)
        self._config = SimpleNamespace(auto_model=SimpleNamespace(config=config))

    def _first_module(self):
        return self._config

    def to(self, **kwargs):
        self.to_kwargs = kwargs
        return self

    def encode(self, prompts, **kwargs):
        return np.ones((len(prompts), 768), dtype=np.float32)


def _encoder_kwargs():
    return {
        "model_id": EMBEDDING_GEMMA_MODEL,
        "model_revision": EMBEDDING_GEMMA_REVISION,
        "tokenizer_revision": EMBEDDING_GEMMA_REVISION,
        "dimension": 768,
        "document_prompt_template": EMBEDDING_GEMMA_DOCUMENT_PROMPT,
        "query_prompt_template": EMBEDDING_GEMMA_QUERY_PROMPT,
        "document_prompt_version": EMBEDDING_GEMMA_DOCUMENT_PROMPT_VERSION,
        "query_prompt_version": EMBEDDING_GEMMA_QUERY_PROMPT_VERSION,
    }


def test_cpu_device_selection_never_requires_cuda(monkeypatch):
    torch = _FakeTorch(available=False)
    monkeypatch.setenv("FJU_EMBEDDING_DEVICE", "auto")
    monkeypatch.setenv("FJU_EMBEDDING_THREADS", "4")
    assert _select_embedding_device(torch) == "cpu"

    sentence_transformers = types.ModuleType("sentence_transformers")
    sentence_transformers.SentenceTransformer = lambda *args, **kwargs: _FakeModel()
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "sentence_transformers", sentence_transformers)
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    encoder = EmbeddingGemmaEncoder(**_encoder_kwargs())

    assert encoder.device == "cpu"
    assert encoder.cpu_threads == 4
    assert torch.thread_count == 4
    assert encoder._model.to_kwargs["dtype"] is torch.float32


def test_explicit_cuda_fails_when_cuda_is_unavailable():
    with pytest.raises(RuntimeError, match="CUDA is unavailable"):
        _select_embedding_device(_FakeTorch(available=False), "cuda")


def test_embeddinggemma_revision_and_prompt_errors_are_rejected():
    with pytest.raises(ValueError, match="model revision"):
        EmbeddingGemmaEncoder(**{**_encoder_kwargs(), "model_revision": "wrong"})
    with pytest.raises(ValueError, match="query prompt version"):
        EmbeddingGemmaEncoder(**{**_encoder_kwargs(), "query_prompt_version": "wrong"})


def test_non_finite_embedding_is_rejected(monkeypatch):
    torch = _FakeTorch(available=False)
    sentence_transformers = types.ModuleType("sentence_transformers")
    sentence_transformers.SentenceTransformer = lambda *args, **kwargs: _FakeModel()
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "sentence_transformers", sentence_transformers)
    encoder = EmbeddingGemmaEncoder(**_encoder_kwargs(), device="cpu")
    encoder._model.encode = lambda *args, **kwargs: np.full((1, 768), np.nan, dtype=np.float32)
    with pytest.raises(RuntimeError, match="non-finite"):
        encoder.encode_query("測試")
