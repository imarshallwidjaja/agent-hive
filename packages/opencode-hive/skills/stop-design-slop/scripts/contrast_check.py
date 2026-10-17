#!/usr/bin/env python3
"""WCAG 2.x contrast ratio checker for text and non-text UI colour pairs.

Usage:
    python3 scripts/contrast_check.py "#FFFFFF" "#777777"
    python3 scripts/contrast_check.py fff 777
    python3 scripts/contrast_check.py --selftest

Accepts 6-digit or 3-digit hex, with or without a leading "#". Prints the
ratio to two decimals and a PASS/FAIL verdict for normal text (4.5:1, WCAG
1.4.3), large text (3.0:1), and non-text UI components (3.0:1, WCAG 1.4.11).
Exit code 0 when normal text passes, 1 when it fails, 2 on a usage error.

Formula: each sRGB channel is c/255, linearised as c/12.92 when c <= 0.03928
and ((c + 0.055) / 1.055) ** 2.4 otherwise; relative luminance is
L = 0.2126 R + 0.7152 G + 0.0722 B; ratio = (Lmax + 0.05) / (Lmin + 0.05).

Adapted from anti-slop by Miqdad Badjuber, MIT,
https://github.com/miqdadbadjuber/anti-slop.
"""

import re
import sys

NORMAL_TEXT_MIN = 4.5
LARGE_TEXT_MIN = 3.0
NON_TEXT_MIN = 3.0

# (foreground, background, expected ratio rounded to two decimals)
SELFTEST_PAIRS = (
    ("#FFFFFF", "#777777", 4.48),
    ("#555555", "#000000", 2.82),
    ("#000000", "#FFFFFF", 21.00),
    ("#FFFFFF", "#767676", 4.54),
    ("#FFFFFF", "#333333", 12.63),
    ("fff", "000", 21.00),
)


def parse_hex(value):
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", text):
        raise ValueError(f"expected a hex colour like #FFFFFF or #FFF, got {value!r}")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def linearise(channel):
    c = channel / 255.0
    if c <= 0.03928:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (linearise(ch) for ch in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(colour_a, colour_b):
    lighter, darker = sorted((luminance(colour_a), luminance(colour_b)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def selftest():
    failures = 0
    for fg, bg, expected in SELFTEST_PAIRS:
        computed = round(contrast_ratio(parse_hex(fg), parse_hex(bg)), 2)
        if f"{computed:.2f}" != f"{expected:.2f}":
            failures += 1
            print(f"selftest: {fg} on {bg}: expected {expected:.2f}, computed {computed:.2f}")
    if failures:
        return 1
    print(f"selftest: {len(SELFTEST_PAIRS)} reference pairs OK")
    return 0


def main(argv):
    if argv == ["--selftest"]:
        return selftest()
    if len(argv) != 2:
        print("usage: python3 contrast_check.py <fg-hex> <bg-hex> | --selftest")
        return 2
    try:
        ratio = contrast_ratio(parse_hex(argv[0]), parse_hex(argv[1]))
    except ValueError as exc:
        print(f"error: {exc}")
        return 2

    normal = ratio >= NORMAL_TEXT_MIN
    verdict = lambda ok: "PASS" if ok else "FAIL"
    print(f"ratio: {ratio:.2f}:1")
    print(f"normal text (4.5:1): {verdict(normal)}")
    print(f"large text  (3.0:1): {verdict(ratio >= LARGE_TEXT_MIN)}")
    print(f"non-text UI (3.0:1, WCAG 1.4.11): {verdict(ratio >= NON_TEXT_MIN)}")
    return 0 if normal else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
