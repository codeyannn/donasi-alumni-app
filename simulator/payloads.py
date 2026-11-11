"""
payloads.py
Generates realistic multi-bank donation webhook payloads with support for:
- Embedded reference codes (--ref A000471 or G000012)
- Multi-bank narrations (BSI, Mandiri, BCA, BNI, BRI)
- Specific amount and program tags
"""

import random
import uuid
from datetime import datetime, timezone

SUPPORTED_BANKS = ["BSI", "MANDIRI", "BCA", "BNI", "BRI"]
SAMPLE_DONORS = [
    "Ahmad Rizki", "Siti Nurhaliza", "Muhammad Rafi",
    "Farhan Aditya", "Dimas Anugrah", "Nabila Putri"
]
SAMPLE_TAGS = ["BEASISWA", "PRESTASI", "WAKAF", "ZAKAT", "INFAQ", ""]


def build_bank_description(bank: str, donor: str, tag: str = "", ref_code: str = "") -> str:
    """
    Builds realistic mutation narrative incorporating optional ref_code and program tag.
    """
    bank = bank.upper()
    ref_suffix = f" {ref_code}" if ref_code else ""
    tag_suffix = f" {tag}" if tag else ""

    if bank == "BSI":
        return f"TRF CR DARI 7129384756 {donor.upper()}{ref_suffix}{tag_suffix}"
    elif bank == "BCA":
        ref = f"0811/FTSCY/WS{random.randint(10000, 99999)}"
        return f"TRSF E-BANKING CR {ref} {donor.upper()}{ref_suffix}{tag_suffix}"
    elif bank == "MANDIRI":
        acc = f"13700{random.randint(10000000, 99999999)}"
        return f"TRANSFER DARI {acc} AN {donor.upper()}{ref_suffix}{tag_suffix}"
    elif bank == "BNI":
        return f"TRF BI-FAST CR DARI BNI 987654321 {donor.upper()}{ref_suffix}{tag_suffix}"
    elif bank == "BRI":
        acc = f"001201000{random.randint(100000, 999999)}"
        return f"TRANSFER BRIMO DARI {acc} {donor.upper()}{ref_suffix}{tag_suffix}"
    else:
        return f"TRANSFER DARI {donor.upper()}{ref_suffix}{tag_suffix}"


def generate_mutation(
    bank: str = None,
    donor: str = None,
    amount: float = None,
    tag: str = None,
    ref_code: str = None,
    mutation_id: str = None,
    is_credit: bool = True
) -> dict:
    """
    Generates a single mutation record.
    """
    selected_bank = (bank or random.choice(SUPPORTED_BANKS)).upper()
    selected_donor = donor or random.choice(SAMPLE_DONORS)
    selected_amount = amount if amount is not None else float(random.choice([50000, 100000, 250000, 500000, 1000000]))
    selected_tag = tag if tag is not None else random.choice(SAMPLE_TAGS)
    selected_id = mutation_id or f"MUT_{selected_bank}_{int(datetime.now(timezone.utc).timestamp())}_{uuid.uuid4().hex[:6]}"
    tx_time = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    desc = build_bank_description(selected_bank, selected_donor, selected_tag, ref_code or "")

    return {
        "mutation_id": selected_id,
        "bank": selected_bank,
        "account_number": f"{random.randint(1000, 9999)}****{random.randint(10, 99)}",
        "account_number_masked": f"{random.randint(10, 99)}****{random.randint(10, 99)}",
        "transaction_date": tx_time,
        "amount": selected_amount,
        "type": "CR" if is_credit else "DB",
        "description": desc
    }

