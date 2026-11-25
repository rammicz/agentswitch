import os,sys,json,pty,select,time,termios,fcntl,struct,signal,subprocess
import re
from pty_wait import bound,missing
from console_text import line_ends
WAIT=20
# Markers match visible text; frames and output keep their colour (SGR) sequences for colour assertions.
SGR=re.compile(r'\x1b\[[0-9;]*m')
output='';visible='';pending='';matched_until=0
def received(data):
 # Keep a colour-free copy for marker matching; a colour sequence split across reads waits for its end.
 global output,visible,pending
 output+=data;pending+=data
 cut=pending.rfind('\x1b')
 hold=cut>=0 and re.fullmatch(r'\x1b(\[[0-9;]*)?',pending[cut:])
 ready,pending=(pending[:cut],pending[cut:]) if hold else (pending,'')
 visible+=SGR.sub('',ready)
def begin_action():
 global matched_until
 # A key/signal/resize must wait for fresh output, not the previous frame's tail.
 matched_until=len(visible)

def read_until(needle=None,timeout=WAIT):
 global matched_until
 timeout=bound(timeout);chunk='';end=time.monotonic()+timeout
 while time.monotonic()<end:
  match=visible.find(needle,matched_until) if needle else -1
  if match>=0:
   # Consume only the expected marker; coalesced later markers remain matchable.
   matched_until=match+len(needle)
   # Preserve whole frames and drain queued redraws before the next action.
   while select.select([master],[],[],0.05)[0]:
    data=os.read(master,65536).decode('utf8',errors='replace');received(data);chunk+=data
   return chunk
  if select.select([master],[],[],0.03)[0]:
   try: data=os.read(master,65536).decode('utf8',errors='replace')
   except OSError: break
   received(data);chunk+=data
   if needle: continue
  if p.poll() is not None:
   if not select.select([master],[],[],0)[0]: break
  if not needle and chunk: return chunk
 if needle: raise missing(needle,output,timeout)
 return chunk

def main():
 global master,slave,p,output,visible,pending,matched_until
 config=json.load(sys.stdin)
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,140,0,0))
 before=termios.tcgetattr(slave)
 env=os.environ.copy();env.update(config['env'])
 p=subprocess.Popen(['node','test/fixtures/picker.mjs'],stdin=slave,stdout=slave,stderr=slave,env=env)
 output='';visible='';pending='';matched_until=0;frames=[]
 try:
  frames.append(read_until(config.get('initial','Alpha task')))
  for action in config['actions']:
   if any(key in action for key in ('send','signal','resize')): begin_action()
   if 'send' in action: os.write(master,action['send'].encode())
   if 'signal' in action: p.send_signal(getattr(signal,action['signal']))
   if 'resize' in action:
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',action['resize'][0],action['resize'][1],0,0));p.send_signal(signal.SIGWINCH)
   frames.append(read_until(action.get('wait'),action.get('timeout',WAIT)))
  p.wait(timeout=bound(WAIT))
  read_until(timeout=.1)
  after=termios.tcgetattr(slave)
  print(json.dumps({'frames':[line_ends(frame) for frame in frames],'output':line_ends(output),'code':p.returncode,'restored':before==after}))
 finally:
  if p.poll() is None: p.kill();p.wait()
  os.close(master);os.close(slave)

if __name__ == '__main__': main()
