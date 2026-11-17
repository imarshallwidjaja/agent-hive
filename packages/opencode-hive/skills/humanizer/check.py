#!/usr/bin/env python3
"""Mechanical sweep for the humanizer skill. Stdlib only.

Usage: python3 check.py <file>   (or - for stdin)

Counts what eyes miss in a final read: dashes, semicolons, stock AI words,
filler transitions, pause-and-point lines, closers, bold-label starts, and the
sentence-length band as a neutral observation, plus trailing exclusions,
rather-than tails, two-sentence negations, question-word headings, figures,
significance crowns, label openers, and intensifiers. It flags; it never
rewrites. A hit is a prompt to look, not a verdict.

Ported from check.py in phuryn/work-humanizer (MIT, see LICENSE.workhumanizer).
This copy writes dash characters as escapes so the file stays ASCII, and skips
fenced code blocks and inline code spans before counting. The counts from
trailing exclusions onward are local additions, not part of the upstream
script. Trailing exclusions, two-sentence negations, question-word headings,
figures, significance crowns, and label-opener prefixes are adapted from a
local measurement of assistant prose. Rather-than tails and intensifiers are
new here and were not tuned against that measurement.

Known false alarms, left in on purpose because a hit only asks for a look:
- trailing exclusions: a numeric or factual correction ("18 ms, not 20 ms.")
  and a mid-sentence aside that runs to the end ("A, not B, ships it.").
- rather-than tails: a plain comparison of two named options.
- two-sentence negation: a real diagnosis ("The test is not flaky. The fixture
  is stale.") has the same form.
- question-word headings: required template sections such as "## Why".
- figures: literal uses of "lives in", "sits at", "the shape of", "wearing".
- significance crowns: "the actual value" naming a literal value.
- label openers: a listed phrase used as a real field name, such as "Rule:"
  heading a list of rules.
- intensifiers: "deeply nested", "truly random" as technical terms.
"""
import re
import statistics
import sys

AI_WORDS = ("delve bolster illuminate elucidate transcend intertwine espouse exemplify "
            "underpin underscore tapestry synergy beacon interplay intricacies intricate "
            "symphony kaleidoscope myriad plethora advancements vibrant meticulous "
            "cutting-edge game-changing unparalleled commendable indelible poignant "
            "tireless unwavering unyielding timeless ever-evolving").split()
AI_PHRASES = ["shed light on", "grapple with", "important to note", "stands as a testament",
              "navigate the complexities", "key takeaway", "paving the way", "look no further",
              "that being said", "in today's fast-paced", "ever-changing landscape",
              "harness the power", "thrilled to announce", "excited to announce"]
MARKETING = ["empower", "unlock", "elevate", "seamless", "streamline", "revolutioniz",
             "supercharge", "next-level", "best-in-class", "world-class", "game-changer"]
TRANSITIONS = ["Additionally", "Furthermore", "Moreover", "However", "Importantly", "Critically",
               "Notably", "Ultimately", "Therefore", "In fact", "In conclusion", "Lastly",
               "That said", "Needless to say", "In other words"]
POINTING = [r"here'?s (the thing|what|why)", r"let me (be clear|explain)", r"let'?s (break|dive)",
            r"^[A-Z][^.:!?\n]{2,40}: [a-z]", r"notice how", r"as you can see", r"this means that",
            r"what do you think\?", r"\bthoughts\?\s*$", r"the bottom line", r"let that sink in",
            r"it'?s not (just )?(about )?[^.]{1,40}[,.;] it'?s", r"\bnot just\b[^.]{1,60}\bbut\b"]
HEDGES = ["arguably", "it's worth noting", "it is worth noting", "could potentially",
          "it's important to note", "it is important to note"]
OPENER_WORDS = {"the", "it's", "that's", "this", "you", "it", "these"}
EM_DASH = "\u2014"
SPACED_DASHES = " \u2013 | -- "
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})(.*)$")
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)[^\n]+?(?<!`)\1(?!`)")

# Local detectors. Tail patterns read one line at a time with parenthetical
# text masked; they count list items and field lines but skip table rows.
DASH_LEAD = r"(?:[,;\u2014\u2013]|(?<=\S) --? )"
TAIL_END = r"[^.!?;()\n]{1,65}(?=[.!?](?:\s|$)|$)"
TRAILING_NOT = re.compile(DASH_LEAD + r"[ \t]*(not[ \t]+" + TAIL_END + ")", re.I | re.M)
RATHER_TAIL = re.compile(r"\b(rather than[ \t]+" + TAIL_END + ")", re.M)
PAREN = re.compile(r"\([^()\n]*\)")
NEGATION_PAIR = re.compile(
    r"\b(?:it|this|that|the [\w-]+)\s+(?:is not|isn['\u2019]t|was not|wasn['\u2019]t)\s+"
    r"[^.!?\n]{1,100}[.!?;][ \t]*(?:it(?:\s+is|['\u2019]s)|this\s+is|that\s+is|the [\w-]+\s+is)\b",
    re.I)
QUESTION_HEADING = re.compile(
    r"^[ ]{0,3}#{1,6}[ \t]+(?:\d+[.)][ \t]+)?((?:what|why|how|where|when)\b.*?)[ \t#]*$", re.I | re.M)
FIGURES = re.compile(
    r"\b(?:load-bearing|earns? its (?:keep|place)|smoking gun|heavy lifting|"
    r"doing (?:a lot of|real) work|wearing|costumes?|in disguise|masquerad\w*|"
    r"dressed (?:up )?as|sits? at|lives? in|the shape of|footguns?|quietly)\b", re.I)
CROWNS = re.compile(
    r"\bthe\s+(?:real|actual|key|whole|honest)\s+(?:issue|problem|question|insight|point|answer|"
    r"risk|blocker|failure|change|difference|constraint|gap|win|takeaway|reason|thing|decision|"
    r"conclusion|benefit|value|concern|purpose|story|detail|signal|lesson)\b"
    r"|\bworth\s+(?:noting|flagging|naming|stating)\b|\bwhat\s+matters\b", re.I)
INTENSIFIERS = re.compile(r"\b(?:genuinely|truly|incredibly|deeply|fundamentally|remarkably)\b", re.I)
LABEL_PREFIX = re.compile(
    r"^(?:(?:the\s+)?(?:one\s+caveat|short\s+version|quick\s+version|key\s+point|key\s+takeaway|"
    r"takeaway|quick\s+answer|direct\s+answer|short\s+answer|important\s+distinction|main\s+point|"
    r"the\s+catch|one\s+catch|net\s+effect|upshot|punchline|gist|rule|core\s+point)|"
    r"here['\u2019]s\s+the\s+(?:thing|catch|gist|rule|problem|point|difference)|"
    r"the\s+(?:short|real|honest)\s+answer)\s*:(?:\s+\S|$)"
    r"|^(?:what this settles|(?:one|two|three|four|five) (?:things?|points?|caveats?|"
    r"constraints?|questions?)(?: worth \w+)?)\.$", re.I)
LIST_MARK = re.compile(r"^\s*(?:[-+*>]|\d+[.)])\s+")


def strip_code(text):
    # CommonMark fences: the closer uses the opener's character, is at least as
    # long, and has no info string; an unterminated fence runs to the end.
    kept, fence = [], None
    for line in text.split("\n"):
        m = FENCE.match(line)
        if fence is None:
            if m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
                fence = m.group(1)
            else:
                kept.append(line)
        elif m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) \
                and not m.group(2).strip():
            fence = None
    return INLINE_CODE.sub(" ", "\n".join(kept))


def sample(found, n=3, width=40):
    # A count plus the first few excerpts, so long inputs keep one short line.
    if not found:
        return ""
    shown = ", ".join('"' + s.strip()[:width] + '"' for s in found[:n])
    return f"{len(found)} [{shown}{', ...' if len(found) > n else ''}]"


def terms(found):
    return f"{len(found)} [{', '.join(sorted({s.lower() for s in found}))}]" if found else ""


def label_openers(prose):
    hits = []
    for line in prose.split("\n"):
        body = LIST_MARK.sub("", line)
        hits += [s for s in re.split(r"(?<=[.!?])\s+", body.strip()) if LABEL_PREFIX.search(s)]
    return hits


def sentences(text):
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in parts if len(p.strip().split()) >= 2]


def check(text):
    text = strip_code(text)
    low = text.lower()
    out = []
    n_words = len(text.split()) or 1

    def flag(label, hits):
        if hits:
            out.append(f"{label}: {hits}")

    flag("em/en dashes", text.count(EM_DASH) + len(re.findall(SPACED_DASHES, text)))
    flag("semicolons", text.count(";"))
    flag("AI words", [w for w in AI_WORDS if re.search(r"\b" + re.escape(w), low)])
    flag("AI phrases", [p for p in AI_PHRASES if p in low])
    flag("marketing words", [w for w in MARKETING if w in low])
    flag("filler transitions", [t for t in TRANSITIONS
                                if re.search(r"(^|[.!?]\s+|\n)" + t + r"\b", text)])
    flag("pause-and-point / closers / contrasts",
         [m.group(0)[:50] for p in POINTING for m in re.finditer(p, text, re.I | re.M)])
    flag("filler hedges", [h for h in HEDGES if h in low])
    flag("bold-label starts", len(re.findall(r"^\s*\*\*[^*]{1,60}(?:\*\*[.:]|[.:]\*\*)", text, re.M)))
    flag("exclamation marks", text.count("!"))

    prose = text.replace("**", "").replace("__", "")
    tail_lines = [PAREN.sub(lambda m: " " * len(m.group(0)), line)
                  for line in prose.split("\n") if not line.lstrip().startswith("|")]
    tails = "\n".join(tail_lines)
    flag("trailing exclusions", sample([m.group(1) for m in TRAILING_NOT.finditer(tails)]))
    flag("rather-than tails", sample([m.group(1) for m in RATHER_TAIL.finditer(tails)]))
    flag("two-sentence negation", sample([m.group(0) for m in NEGATION_PAIR.finditer(prose)]))
    flag("question-word headings",
         sample([m.group(1) for m in QUESTION_HEADING.finditer(prose)], n=5, width=60))
    flag("figures", terms([m.group(0) for m in FIGURES.finditer(prose)]))
    flag("significance crowns", sample([m.group(0) for m in CROWNS.finditer(prose)]))
    flag("label openers", sample(label_openers(prose)))
    flag("intensifiers", terms([m.group(0) for m in INTENSIFIERS.finditer(prose)]))

    lens = [len(s.split()) for s in sentences(text)]
    if len(lens) >= 4:
        med = statistics.median(lens)
        band = sum(1 for x in lens if abs(x - med) <= 5) / len(lens)
        mean = statistics.mean(lens)
        note = ""
        if band >= 0.7:
            note = " (uniform length)"
        out.append(f"sentences: {len(lens)}, mean {mean:.1f} words, "
                   f"{band:.0%} within 5 words of the median{note}")
        starts = [s.split()[0].lower().strip('"\'') for s in sentences(text)]
        share = sum(1 for s in starts if s in OPENER_WORDS) / len(starts)
        if share >= 0.4:
            out.append(f"openers: {share:.0%} of sentences start with The/It/This/That/You")
    out.append(f"words: {n_words}")
    return out


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    src = sys.stdin.read() if len(sys.argv) < 2 or sys.argv[1] == "-" else \
        open(sys.argv[1], encoding="utf-8").read()
    print("\n".join(check(src)))
