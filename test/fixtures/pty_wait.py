"""Wait bounds and failure text shared by the PTY test drivers.

A wait ends as soon as its marker appears, so a bound only limits a real hang. The defaults leave room for a loaded
machine; AGENTSWITCH_TEST_TIMEOUT_SCALE multiplies every bound (for example 2 on a very slow host, 0.1 to fail fast).
"""
import math,os,re

def _scale():
 value=os.environ.get('AGENTSWITCH_TEST_TIMEOUT_SCALE') or '1'
 try:scale=float(value)
 except ValueError:scale=math.nan
 if not math.isfinite(scale) or scale<=0:raise ValueError('AGENTSWITCH_TEST_TIMEOUT_SCALE must be a positive number')
 return scale
SCALE=_scale()

def bound(seconds):
 """A wait bound in seconds, scaled for this machine."""
 return seconds*SCALE

_controls=re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]')

def last_screen(output,limit=4000):
 """The text of the last full-screen redraw, without terminal control sequences."""
 text=output[output.rfind('\x1b[2J')+4:] if '\x1b[2J' in output else output
 text=_controls.sub('',text).replace('\r\n','\n').replace('\r','\n')
 return text[-limit:]

def missing(marker,output,seconds):
 """The failure for a marker that did not appear within its bound."""
 return Exception(f'Missing {marker!r} within {seconds:g}s; last screen:\n{last_screen(output)}')
