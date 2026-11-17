#!/usr/bin/env python3
"""Call NEAR AI Cloud (cloud-api.near.ai) with an API key from the environment.

This is the portable version of the AI helper used by the Gavel bidder bot
(scripts/bot.js). It does the same thing as the workspace connector helper,
but it takes the key from NEAR_AI_API_KEY instead of Muse's secure store,
so anyone cloning this repo can run it.

Setup:
  export NEAR_AI_API_KEY="<your NEAR AI Cloud API key>"
  Get a key at https://cloud.near.ai (sign in, create an API key).

  The key is never printed, logged, or written anywhere by this script.
  Never commit a real key to the repo.

Usage:
  python3 near-ai-call.py models
      GET /v1/models. A harmless read that proves the key works.
      Prints the model catalog JSON.

  python3 near-ai-call.py complete
      Reads one JSON object from stdin:
        {"model": "anthropic/claude-haiku-4-5", "messages": [...],
         "max_tokens": 300, "temperature": 0.4}
      Does the attestation preflight (GET /v1/attestation/report with a
      fresh nonce, trusted only if the report echoes the nonce), then
      POST /v1/chat/completions, and prints:
        {"output": "...", "worker": "llm", "model": "...",
         "provider": "near-ai", "verifiable": true,
         "attestation": {...} | null, "chat_id": "..." | null}

Exit 0 on success. Errors go to stderr with a non-zero exit; the key is
never printed.
"""
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://cloud-api.near.ai/v1"
DEFAULT_MODEL = "anthropic/claude-haiku-4-5"


def _api_key():
    key = os.environ.get("NEAR_AI_API_KEY", "").strip()
    if not key:
        raise SystemExit(
            "near-ai-call: NEAR_AI_API_KEY is not set. "
            "Get a key at https://cloud.near.ai and export NEAR_AI_API_KEY."
        )
    return key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def _open(request, timeout):
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)


def _read_json(response):
    raw = response.read().decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"NEAR AI returned non-JSON: {raw[:200]!r} ({exc})")


def _get_json(url, key, timeout=60):
    request = urllib.request.Request(url, method="GET")
    request.add_header("Authorization", "Bearer " + key)
    request.add_header("x-no-aliasing", "true")
    with _open(request, timeout) as response:
        return _read_json(response)


def _post_json(url, body, key, timeout=120):
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Authorization", "Bearer " + key)
    request.add_header("Content-Type", "application/json")
    request.add_header("x-no-aliasing", "true")
    with _open(request, timeout) as response:
        return _read_json(response)


def cmd_models(key):
    result = _get_json(BASE + "/models", key, timeout=60)
    print(json.dumps(result))


def cmd_complete(key):
    try:
        req = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"complete: stdin was not valid JSON: {exc}")
    model = req.get("model") or DEFAULT_MODEL
    messages = req.get("messages")
    if not isinstance(messages, list) or not messages:
        raise SystemExit("complete: 'messages' must be a non-empty list")
    max_tokens = int(req.get("max_tokens") or 300)
    temperature = float(req.get("temperature", 0.4))

    # Preflight attestation evidence, fetched BEFORE the completion.
    attestation = None
    try:
        nonce = secrets.token_hex(32)
        url = (
            BASE + "/attestation/report?model=" + urllib.parse.quote(model, safe="")
            + "&signing_algo=ecdsa&nonce=" + nonce
        )
        ev = _get_json(url, key, timeout=60)
        gateway = ev.get("gateway_attestation") or {}
        models = ev.get("model_attestations") or []
        first_model = models[0] if models else {}
        if gateway.get("request_nonce") == nonce or first_model.get("request_nonce") == nonce:
            attestation = {
                "nonce": nonce,
                "gateway_attestation": ev.get("gateway_attestation"),
                "model_attestations": ev.get("model_attestations"),
            }
        else:
            print("attestation nonce mismatch, continuing without evidence", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 - attestation is best-effort, never blocks the call
        print(f"attestation evidence fetch failed, continuing without it: {exc}", file=sys.stderr)

    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    result = _post_json(BASE + "/chat/completions", body, key, timeout=120)
    choices = result.get("choices") or []
    content = ""
    if choices:
        content = (choices[0].get("message") or {}).get("content") or ""
    content = content.strip()
    if len(content) <= 20:
        raise SystemExit("complete: empty model output")
    response_attestation = (
        result.get("gateway_attestation")
        or result.get("model_attestations")
        or result.get("attestation")
        or None
    )
    print(json.dumps({
        "output": content,
        "worker": "llm",
        "model": model,
        "provider": "near-ai",
        "verifiable": True,
        "attestation": attestation or ({"response": response_attestation} if response_attestation else None),
        "chat_id": result.get("id"),
    }))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("models", "complete"):
        print("usage: near-ai-call.py models|complete", file=sys.stderr)
        return 2
    try:
        key = _api_key()
        if sys.argv[1] == "models":
            cmd_models(key)
        else:
            cmd_complete(key)
    except SystemExit as exc:
        # _api_key / input errors: message already explains itself.
        if exc.code:
            print(str(exc), file=sys.stderr)
        return 1
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        print(f"near-ai-call failed: HTTP {exc.code} {exc.reason} {body}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - surface the failure, never the secret
        print(f"near-ai-call failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
