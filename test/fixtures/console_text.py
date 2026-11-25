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

# A carriage return just before a line feed moves nothing a terminal shows: the line feed starts the next row either
# way. macOS CI (Node 22.15.0) delivered a review row as "...\r\r\n", so rows are split on any such run.
_LINE_END = re.compile(r'\r*\n')

def rows(text):
    return _LINE_END.split(text)

def line_ends(text):
    """The same output with every line ending written as one CR LF."""
    return _LINE_END.sub('\r\n', text)
