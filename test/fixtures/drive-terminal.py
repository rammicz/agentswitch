import os,sys,json,pty,select,time,termios,fcntl,struct,signal,subprocess
config=json.load(sys.stdin)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,140,0,0))
before=termios.tcgetattr(slave)
env=os.environ.copy();env.update(config['env'])
p=subprocess.Popen(['node','test/fixtures/picker.mjs'],stdin=slave,stdout=slave,stderr=slave,env=env)
output='';frames=[]
def read_until(needle=None,timeout=4):
 global output
 chunk='';end=time.monotonic()+timeout
 while time.monotonic()<end:
  if select.select([master],[],[],0.03)[0]:
   try: data=os.read(master,65536).decode('utf8',errors='replace')
   except OSError: break
   output+=data;chunk+=data
   if needle and needle in chunk:
    # Drain frames already queued by the same async operation before the next key.
    while select.select([master],[],[],0.05)[0]:
     data=os.read(master,65536).decode('utf8',errors='replace');output+=data;chunk+=data
    return chunk
  if p.poll() is not None:
   if not select.select([master],[],[],0)[0]: break
  if not needle and chunk: return chunk
 if needle: raise Exception('Missing '+repr(needle)+' in '+repr(chunk)+'; all '+repr(output))
 return chunk
try:
 frames.append(read_until(config.get('initial','Alpha task')))
 for action in config['actions']:
  if 'send' in action: os.write(master,action['send'].encode())
  if 'signal' in action: p.send_signal(getattr(signal,action['signal']))
  if 'resize' in action:
   fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',action['resize'][0],action['resize'][1],0,0));p.send_signal(signal.SIGWINCH)
  frames.append(read_until(action.get('wait'),action.get('timeout',4)))
 p.wait(timeout=4)
 read_until(timeout=.1)
 after=termios.tcgetattr(slave)
 print(json.dumps({'frames':frames,'output':output,'code':p.returncode,'restored':before==after}))
finally:
 if p.poll() is None: p.kill();p.wait()
 os.close(master);os.close(slave)
