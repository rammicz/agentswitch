import sys
sys.dont_write_bytecode=True
from contextlib import contextmanager
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('terminal_driver', Path(__file__).with_name('drive-terminal.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

class TerminalReaderTest(unittest.TestCase):
 @contextmanager
 def reader(self, chunks):
  driver.output='';driver.matched_until=0;driver.master=12345
  driver.p=SimpleNamespace(poll=lambda: None if chunks else 0)
  with patch.object(driver.select,'select',side_effect=lambda *args: ([driver.master],[],[]) if chunks else ([],[],[])), patch.object(driver.os,'read',side_effect=lambda *args: chunks.pop(0).encode()):
   yield

 def test_sequential_waits_retain_split_and_coalesced_markers(self):
  for marker in ['LATE PREVIEW','LATE PREPARE']:
   stream='frame\nDONE {}\r\n'+marker+'\r\n'
   layouts=[('coalesced',[stream]),('split after DONE',[stream[:10],stream[10:]]),('split in marker',[stream[:stream.index(marker)+4],stream[stream.index(marker)+4:]]),('one character per read',list(stream))]
   for name,chunks in layouts:
    with self.subTest(marker=marker,layout=name), self.reader(chunks.copy()):
     first=driver.read_until('DONE');second=driver.read_until(marker)
     self.assertEqual(driver.output,stream)
     self.assertEqual(first+second,stream)
     self.assertEqual(first,stream) # Frames retain whole received/drained output.

 def test_waits_cannot_match_markers_before_the_prior_match(self):
  with self.reader(['LATE PREVIEW\nDONE {}\n']):
   driver.read_until('DONE')
   with self.assertRaisesRegex(Exception,'Missing'):
    driver.read_until('LATE PREVIEW')

 def test_a_driving_action_requires_output_after_the_action_boundary(self):
  chunks=['Alpha task\nEnter preview\n']
  with self.reader(chunks):
   driver.read_until('Alpha task')
   driver.begin_action()
   with self.assertRaisesRegex(Exception,'Missing'):
    driver.read_until('Enter preview')
   chunks.append('fresh frame\nEnter preview\n')
   self.assertEqual(driver.read_until('Enter preview'),'fresh frame\nEnter preview\n')


spec = importlib.util.spec_from_file_location('integration_driver', Path(__file__).with_name('drive-integration.py'))
integration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integration)

class IntegrationReaderTest(unittest.TestCase):
 @contextmanager
 def reader(self, chunks):
  state={'output':'','cursor':0,'master':12345,'child':SimpleNamespace(poll=lambda: None if chunks else 0),'decoder':integration.codecs.getincrementaldecoder('utf8')()}
  with patch.object(integration.select,'select',side_effect=lambda *args: ([state['master']],[],[]) if chunks else ([],[],[])), patch.object(integration.os,'read',side_effect=lambda *args: chunks.pop(0)):
   yield state

 def test_retained_commit_marker_handles_either_order_and_fragmented_utf8_without_tiny_pty_reads(self):
  marker='PID_COMMIT_DONE'
  for commit_first in [True,False]:
   stream=('frame 日本語\n'+(marker+'\r\nREADY' if commit_first else 'READY\r\n'+marker)).encode()
   split=stream.index(marker.encode())+len('PID_COMMIT_')
   layouts=[('coalesced',[stream]),('split marker',[stream[:split],stream[split:]]),('one byte fragments',[bytes([unit]) for unit in stream])]
   for name,chunks in layouts:
    with self.subTest(commit_first=commit_first,layout=name), self.reader(chunks.copy()) as state:
     integration.until(state,'READY');cursor=state['cursor']
     integration.until(state,marker,retained=True)
     self.assertEqual(state['output'],stream.decode())
     self.assertGreaterEqual(state['cursor'],cursor)

 def test_normal_wait_cannot_reuse_an_earlier_commit_marker(self):
  with self.reader([b'PID_COMMIT_DONE\nREADY']) as state:
   integration.until(state,'READY')
   with self.assertRaisesRegex(Exception,'Missing'):
    integration.until(state,'PID_COMMIT_DONE')

class IntegrationCleanupTest(unittest.TestCase):
 def state(self,alive=False):
  return {'child':SimpleNamespace(pid=12345,poll=lambda: None if alive else -9,wait=Mock()),'providerPids':{12346}}

 def test_dead_leader_cleanup_targets_only_observed_provider_pid(self):
  state=self.state()
  with patch.object(integration.os,'getpgid',return_value=12345),patch.object(integration.os,'kill') as kill,patch.object(integration.os,'killpg') as killpg:
   integration.cleanup_processes(state)
   kill.assert_called_once_with(12346,integration.signal.SIGKILL);killpg.assert_not_called();state['child'].wait.assert_called_once()

 def test_live_leader_cleanup_targets_its_isolated_group(self):
  with patch.object(integration.os,'kill') as kill,patch.object(integration.os,'killpg') as killpg:
   integration.cleanup_processes(self.state(alive=True))
   killpg.assert_called_once_with(12345,integration.signal.SIGKILL);kill.assert_not_called()

 def test_unexplained_permission_error_is_not_swallowed(self):
  with patch.object(integration.os,'getpgid',return_value=12345),patch.object(integration.os,'kill',side_effect=PermissionError('unexplained')):
   with self.assertRaisesRegex(PermissionError,'unexplained'):integration.cleanup_processes(self.state())

 def test_changed_group_is_refused_before_any_signal(self):
  with patch.object(integration.os,'getpgid',return_value=99999),patch.object(integration.os,'kill') as kill:
   with self.assertRaisesRegex(Exception,'changed its process group'):integration.cleanup_processes(self.state())
   kill.assert_not_called()

 def test_already_exited_owned_provider_needs_no_signal(self):
  with patch.object(integration.os,'getpgid',side_effect=ProcessLookupError),patch.object(integration.os,'kill') as kill:
   integration.cleanup_processes(self.state());kill.assert_not_called()

if __name__ == '__main__': unittest.main()
