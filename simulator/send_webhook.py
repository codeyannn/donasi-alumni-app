"""
send_webhook.py
CLI tool to dispatch multi-bank donation webhooks with support for Virtual Account, ref_code, and auto-matching.
"""

import argparse
import json
import os
import sys
import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from payloads import generate_mutation, SUPPORTED_BANKS


def parse_args():
    parser = argparse.ArgumentParser(description="Multi-bank donation webhook dispatcher with VA and ref_code support.")
    parser.add_argument("--url", type=str, default=None, help="Apps Script Web App Executable URL")
    parser.add_argument("--token", type=str, default=None, help="Webhook secret token")
    parser.add_argument("--bank", type=str, choices=SUPPORTED_BANKS + [b.lower() for b in SUPPORTED_BANKS], help="Target bank (BSI, Mandiri, BCA, BNI, BRI)")
    parser.add_argument("--amount", type=float, default=None, help="Donation amount in IDR")
    parser.add_argument("--donor", type=str, default=None, help="Donor raw name")
    parser.add_argument("--ref", type=str, default=None, help="Alumni/Guest Reference code (e.g., A000471 or G000012)")
    parser.add_argument("--va", action="store_true", help="Generate mutation in Virtual Account payment format")
    parser.add_argument("--tag", type=str, default="BEASISWA", help="Program keyword (BEASISWA, WAKAF, etc.)")
    parser.add_argument("--duplicate", action="store_true", help="Send duplicate mutation twice to test dedupe")
    parser.add_argument("--bad-token", action="store_true", help="Send wrong token to verify 401 response")
    parser.add_argument("--dry-run", action="store_true", help="Print payload without sending network request")
    return parser.parse_args()


def main():
    args = parse_args()
    target_url = args.url or os.getenv("APPS_SCRIPT_URL")
    token = "WRONG_TOKEN" if args.bad_token else (args.token or os.getenv("WEBHOOK_SECRET_TOKEN", "ALUMNI_UPI_SECRET_TOKEN_2026"))

    mut_id = "MUT_DUP_TEST_9999" if args.duplicate else None
    mut = generate_mutation(
        bank=args.bank,
        donor=args.donor,
        amount=args.amount,
        tag=args.tag,
        ref_code=args.ref,
        use_va=args.va,
        mutation_id=mut_id
    )
    payload = [mut]

    print("=" * 60)
    print("DONASI ALUMNI APP - WEBHOOK SIMULATOR")
    print("=" * 60)
    print(f"Target URL: {target_url or '[Dry-Run Mode]'}")
    print(f"Token:      {token}")
    print(f"Ref Code:   {args.ref or '[None]'}")
    print(f"Format VA:  {'YES (Virtual Account)' if args.va else 'NO (Direct Transfer)'}")
    print("-" * 60)
    print("Payload:")
    print(json.dumps(payload, indent=2))
    print("-" * 60)

    if args.dry_run or not target_url or "REPLACE_WITH" in target_url:
        print("Dry-run completed. No HTTP call dispatched.")
        return

    req_url = f"{target_url}?token={token}"
    print("Sending POST request...")
    try:
        r = requests.post(req_url, headers={"Content-Type": "application/json"}, data=json.dumps(payload), timeout=30)
        print(f"Status Code: {r.status_code}")
        try:
            print("Response:", json.dumps(r.json(), indent=2))
        except Exception:
            print("Response:", r.text)

        if args.duplicate:
            print("\nRe-sending identical mutation to verify deduplication...")
            r2 = requests.post(req_url, headers={"Content-Type": "application/json"}, data=json.dumps(payload), timeout=30)
            print(f"Status Code: {r2.status_code}")
            try:
                print("Response on duplicate:", json.dumps(r2.json(), indent=2))
            except Exception:
                print(r2.text)

    except requests.exceptions.RequestException as e:
        print(f"Network error: {e}")


if __name__ == "__main__":
    main()
