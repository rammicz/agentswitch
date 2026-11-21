import sys
sys.dont_write_bytecode=True
from contextlib import contextmanager
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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

if __name__ == '__main__': unittest.main()
