"""Visible text of terminal output, for matching what a screen shows rather than how it was encoded."""
import re

# Windows ConPTY re-encodes the picker's output: it splits styled runs into separate colour sequences, erases
# with ESC[nX and moves over runs of spaces with ESC[nC. Colour and erase sequences are dropped, cursor-forward
# becomes the spaces it skips, and window-title (OSC) sequences are dropped.
_SEQUENCE = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([\d;]*)([mXKC])')

def visible(text):
    def replace(match):
        return ' ' * int(match.group(1) or 1) if match.group(2) == 'C' else ''
    return _SEQUENCE.sub(replace, text)
