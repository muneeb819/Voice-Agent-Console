#!/usr/bin/env python3
"""Build the identical browser and server seed catalogs from the supplied CSV."""
import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'datasets' / 'Greetings-Dataset.csv'
OUTPUTS = (ROOT / 'public' / 'greetings.json', ROOT / 'docs' / 'greetings.json')
FIELDS = ['greeting_id', 'persona', 'context', 'greeting_text', 'tone']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='fail if generated catalogs are out of date')
    args = parser.parse_args()
    with SOURCE.open(encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != FIELDS:
            raise SystemExit(f'Unexpected CSV columns: {reader.fieldnames}')
        rows = list(reader)
    ids = set()
    for row_number, row in enumerate(rows, start=2):
        if None in row or any(not isinstance(row.get(f), str) or not row[f].strip() for f in FIELDS):
            raise SystemExit(f'Missing or extra fields on CSV line {row_number}')
        if row['greeting_id'] in ids:
            raise SystemExit(f'Duplicate greeting ID: {row["greeting_id"]}')
        ids.add(row['greeting_id'])
    if not rows:
        raise SystemExit('The greeting dataset is empty')
    data = json.dumps({'source': SOURCE.name, 'greetings': rows}, ensure_ascii=False, separators=(',', ':')) + '\n'
    for output in OUTPUTS:
        if args.check:
            if not output.exists() or output.read_text(encoding='utf-8') != data:
                raise SystemExit(f'{output.relative_to(ROOT)} is out of date')
        else:
            output.write_text(data, encoding='utf-8')
    print(f'{"Verified" if args.check else "Generated"} {len(rows)} greetings for public/ and docs/.')


if __name__ == '__main__':
    main()
