"""
send_webhook.py
CLI tool to dispatch multi-bank donation webhooks authenticated via
HMAC-SHA256 + timestamp + nonce inside the JSON POST body (zero URL tokens).
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from payloads import generate_mutation, SUPPORTED_BANKS


def parse_args():
    """Parses CLI flags for simulating manual multi-bank webhook mutations."""
    parser = argparse.ArgumentParser(
        description="Multi-bank donation webhook dispatcher using body HMAC-SHA256 authentication."
    )
    parser.add_argument("--url", type=str, default=None, help="Apps Script Web App Executable URL")
    parser.add_argument("--secret", type=str, default=None, help="Webhook HMAC secret matching ScriptProperties WEBHOOK_MANUAL_SECRET")
    parser.add_argument("--bank", type=str, choices=SUPPORTED_BANKS + [b.lower() for b in SUPPORTED_BANKS], help="Target bank (BSI, Mandiri, BCA, BNI, BRI)")
    parser.add_argument("--amount", type=float, default=None, help="Donation amount in IDR")
    parser.add_argument("--donor", type=str, default=None, help="Donor raw name")
    parser.add_argument("--ref", type=str, default=None, help="Alumni/Guest Reference code (e.g., A000471 or G000012)")
    parser.add_argument("--va", action="store_true", help="Generate mutation in Virtual Account payment format")
    parser.add_argument("--tag", type=str, default="BEASISWA", help="Program keyword (BEASISWA, WAKAF, etc.)")
    parser.add_argument("--duplicate", action="store_true", help="Send identical mutation_id twice (with fresh nonces) to test ledger deduplication")
    parser.add_argument("--bad-token", action="store_true", help="Send invalid HMAC signature to verify 401/500 rejection")
    parser.add_argument("--dry-run", action="store_true", help="Print signed envelope without sending network request")
    return parser.parse_args()


def build_signed_envelope(mutations: list, secret: str, tamper_signature: bool = False) -> dict:
    """
    Constructs an authenticated webhook envelope carrying timestamp, nonce,
    HMAC-SHA256 signature, and exact payload string inside the POST JSON body.
    """
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    payload_raw = json.dumps(mutations)
    canonical_message = f"{timestamp}.{nonce}.{payload_raw}".encode("utf-8")

    # Compute HMAC-SHA256 signature using server shared secret
    signature = hmac.new(
        secret.encode("utf-8"),
        canonical_message,
        hashlib.sha256,
    ).hexdigest()

    if tamper_signature:
        # Intentionally invalidate signature for security rejection tests
        signature = "0" * 64

    return {
        "webhook_auth": {
            "timestamp": timestamp,
            "nonce": nonce,
            "signature": signature,
        },
        "payload_raw": payload_raw,
    }


def main():
    args = parse_args()
    target_url = args.url or os.getenv("APPS_SCRIPT_URL")
    # Never fall back to hardcoded repository secrets (SEC-P0-8)
    secret = args.secret or os.getenv("WEBHOOK_MANUAL_SECRET") or os.getenv("WEBHOOK_SECRET_TOKEN")

    mut_id = "MUT_DUP_TEST_9999" if args.duplicate else None
    mut = generate_mutation(
        bank=args.bank,
        donor=args.donor,
        amount=args.amount,
        tag=args.tag,
        ref_code=args.ref,
        use_va=args.va,
        mutation_id=mut_id,
    )
    mutations = [mut]

    if not secret and not args.dry_run and not args.bad_token:
        print("ERROR: Missing WEBHOOK_MANUAL_SECRET. Set it in .env or pass --secret.", file=sys.stderr)
        sys.exit(1)

    effective_secret = secret or "DRY_RUN_PLACEHOLDER_SECRET"
    envelope = build_signed_envelope(mutations, effective_secret, tamper_signature=args.bad_token)

    print("=" * 60)
    print("DONASI ALUMNI APP - WEBHOOK SIMULATOR (HMAC BODY AUTH)")
    print("=" * 60)
    print(f"Target URL: {target_url or '[Dry-Run Mode]'}")
    print(f"Auth Mode:  HMAC-SHA256 in POST body (zero URL query token)")
    print(f"Ref Code:   {args.ref or '[None]'}")
    print(f"Format VA:  {'YES (Virtual Account)' if args.va else 'NO (Direct Transfer)'}")
    print("-" * 60)
    print("Mutations Payload:")
    print(json.dumps(mutations, indent=2))
    print("-" * 60)

    if args.dry_run or not target_url or "REPLACE_WITH" in target_url:
        print("Signed Envelope Preview (signature redacted in non-verbose check):")
        preview = {
            "webhook_auth": {
                "timestamp": envelope["webhook_auth"]["timestamp"],
                "nonce": envelope["webhook_auth"]["nonce"],
                "signature_prefix": envelope["webhook_auth"]["signature"][:12] + "...",
            },
            "payload_raw": envelope["payload_raw"],
        }
        print(json.dumps(preview, indent=2))
        print("Dry-run completed. No HTTP call dispatched.")
        return

    print("Sending POST request without URL token...")
    try:
        r = requests.post(
            target_url,
            headers={"Content-Type": "text/plain;charset=utf-8"},
            data=json.dumps(envelope),
            timeout=30,
        )
        print(f"Status Code: {r.status_code}")
        try:
            print("Response:", json.dumps(r.json(), indent=2))
        except Exception:
            print("Response:", r.text)

        if args.duplicate:
            print("\nRe-sending identical mutation_id with a fresh nonce to verify idempotency...")
            envelope2 = build_signed_envelope(mutations, effective_secret, tamper_signature=False)
            r2 = requests.post(
                target_url,
                headers={"Content-Type": "text/plain;charset=utf-8"},
                data=json.dumps(envelope2),
                timeout=30,
            )
            print(f"Status Code: {r2.status_code}")
            try:
                print("Response on duplicate:", json.dumps(r2.json(), indent=2))
            except Exception:
                print(r2.text)

    except requests.exceptions.RequestException as e:
        print(f"Network error: {e}")


if __name__ == "__main__":
    main()
