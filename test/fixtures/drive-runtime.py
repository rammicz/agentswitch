"""Controlled foreground process group; never signals the caller's terminal group."""
import os,sys,json,pty,select,time,termios,fcntl,struct,signal,subprocess

def main():
 config=json.load(sys.stdin)
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,140,0,0))
 before=termios.tcgetattr(slave)
 def own_terminal():
  os.setsid()
  fcntl.ioctl(slave,termios.TIOCSCTTY,0)
 env=os.environ.copy();env.update(config['env'])
 ack_read,ack_write=os.pipe()
 env['RUNTIME_ACK_FD']=str(ack_read)
 try:
  child=subprocess.Popen(['node','test/fixtures/runtime-picker.mjs'],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=own_terminal,pass_fds=(ack_read,))
 finally:os.close(ack_read)
 output='';cursor=0
 def until(marker,timeout=5):
  nonlocal output,cursor
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   found=output.find(marker,cursor)
   if found>=0:cursor=found+len(marker);return
   if select.select([master],[],[],0.03)[0]:
    try:data=os.read(master,65536)
    except OSError:break
    if not data:break
    output+=data.decode('utf8',errors='replace')
   elif child.poll() is not None:break
  raise Exception('Missing '+repr(marker)+'; output='+repr(output))
 try:
  until('Enter preview')
  for marker in ['Enter choose target','Target:','Mode:','DISPATCH']:
   os.write(master,b'\r');until(marker)
  for action in config['actions']:
   if 'wait' in action:until(action['wait'])
   if 'send' in action:os.write(master,action['send'].encode())
   if 'signal' in action:child.send_signal(getattr(signal,action['signal']))
   if 'resize' in action:
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',12,60,0,0));os.killpg(child.pid,signal.SIGWINCH)
  until('DONE ');until('\n')
  # macOS revokes a controlling PTY when its session leader exits. Sample the
  # real restored terminal before acknowledging that the leader may exit.
  if child.poll() is not None:raise Exception('Session leader exited before terminal sampling')
  after=termios.tcgetattr(slave)
  sampled_while_alive=child.poll() is None
  if not sampled_while_alive:raise Exception('Session leader exited during terminal sampling')
  os.write(ack_write,b'T');os.close(ack_write);ack_write=None
  child.wait(timeout=5)
  print(json.dumps({'output':output,'code':child.returncode,'restored':before==after,'sampledWhileAlive':sampled_while_alive}))
 finally:
  if ack_write is not None:os.close(ack_write)
  # This process owns the synthetic group, including a failed test's fake child.
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  child.wait();os.close(master);os.close(slave)
if __name__=='__main__':main()
