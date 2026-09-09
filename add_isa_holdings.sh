#!/usr/bin/env bash
# Adds the holdings from Portfolio_ISA_06Sep.xlsx to the dashboard's
# Portfolio, tagged "Steve ISA". Run this from your project root (wherever
# docker-compose.yml lives) with the containers up.
#
# average cost per share = the file's total "Cost" column / "Quantity",
# rounded to the nearest penny (the portfolio_holdings.average_cost column
# is 2dp anyway). Symbols are the bare Yahoo Finance codes with the ".L"
# market suffix stripped, since the service's price provider adds that back
# itself (see service/src/providers/prices.ts's toYahooSymbol). National
# Grid and United Utilities are plain "NG"/"UU" - NOT "NG."/"UU." as an
# earlier version of this script had it (assuming their LSE EPIC codes'
# own trailing dot carried through to Yahoo's symbol too) - confirmed
# against Yahoo directly that "NG.L"/"UU.L" (single dot) are the real
# symbols, the double-dot form returns no quote at all.
#
# The "LIONTR INVT FDS V LT UK LISTED SMLR COS B ACC" line (Sedol B1DSZS0,
# qty 3312.0425, cost £54,457.28) has no simple Yahoo-style code in the
# source file, so it's added below by its ISIN instead: GB00B1DSZS09
# (Sedol B1DSZS0 is embedded in that ISIN, confirming it's the same line).
# This fund shows up under different manager names on different platforms -
# it was River & Mercantile's UK Listed Smaller Companies Fund until
# Liontrust bought River Global (R&M's asset-management arm) in 2022, so
# your broker now lists it as "Liontrust", while some data feeds/factsheets
# (Fidelity, riverandmercantile.com) still carry the legacy "River and
# Mercantile"/"ES R&M" branding - same fund, same ISIN, just old vs new
# owner name. Confirmed on Yahoo Finance directly as symbol
# "GB00B1DSZS09.L".

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4000}"
API_KEY="${API_KEY:-devkey}"
ACCOUNT="Steve ISA"

add() {
  local symbol="$1" name="$2" quantity="$3" avgCost="$4"
  echo "Adding $symbol ($name) x$quantity @ £$avgCost ..."
  # Values are passed as argv (sys.argv), not interpolated into the Python
  # source text - avoids the whole class of shell-quoting bugs that comes
  # from building a Python dict literal as a string (an earlier version of
  # this script did that, and bash's brace expansion mangled it).
  payload="$(python3 -c '
import json, sys
symbol, name, exchange, account, quantity, avg_cost = sys.argv[1:7]
print(json.dumps({
    "symbol": symbol,
    "name": name,
    "exchange": exchange,
    "account": account,
    "quantity": float(quantity),
    "averageCost": float(avg_cost),
}))
' "$symbol" "$name" "LSE" "$ACCOUNT" "$quantity" "$avgCost")"
  curl -sS -X POST "$API_BASE/api/portfolio" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload"
  echo
}

add "AAL"  "Anglo American plc"                                365    23.69
add "BHP"  "BHP Group Ltd"                                     1000   13.56
add "FSV"  "Fidelity Special Values plc"                       32900  4.55
add "GSK"  "GSK plc"                                           2153   13.43
add "IGG"  "IG Group Holdings plc"                             2100   11.47
add "SJPA" "iShares Core MSCI Japan IMI UCITS ETF"              731    61.48
add "EMIM" "iShares Core MSCI EM IMI UCITS ETF"                1708   40.97
add "NG"   "National Grid plc"                                 3264   6.67
add "SMT"  "Scottish Mortgage Investment Trust plc"            5000   5.00
add "TLW"  "Tullow Oil plc"                                     116000 0.13
add "UU"   "United Utilities Group plc"                         3392   7.14
add "UEM"  "Utilico Emerging Markets Trust plc"                10712  2.80
add "VERX" "Vanguard FTSE Developed Europe ex-UK UCITS ETF"     1144   43.70
add "GB00B1DSZS09" "Liontrust UK Listed Smaller Companies Fund B Acc" 3312.0425 16.44

echo "Done - 14 holdings added. Verify with:"
echo "  curl -s -H \"Authorization: Bearer \$API_KEY\" \"$API_BASE/api/portfolio?account=Steve+ISA\" | python3 -m json.tool"
