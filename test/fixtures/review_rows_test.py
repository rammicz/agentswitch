import sys
sys.dont_write_bytecode=True
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('integration_driver',Path(__file__).with_name('drive-integration.py'))
driver=importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

class ReviewRowsTest(unittest.TestCase):
 def test_a_carriage_return_before_a_line_feed_is_not_row_text(self):
  # macOS CI (Node 22.15.0) delivered one exact-payload row as "...Th\r\r\n": a terminal shows it as "...Th".
  frame='\x1b[2J\x1b[H heading\r\n\r\n BEGIN\r\n "{\\"a\\":\r\r\n 1}"\r\n END\r\n\r\n Enter confirm continuation  Esc back'
  self.assertEqual(driver.review_body('old frame'+frame),['BEGIN','"{\\"a\\":','1}"','END'])


 def test_returned_output_writes_each_line_end_once(self):
  self.assertEqual(driver.line_ends('a\r\r\nb\r\nc\n'),'a\r\nb\r\nc\r\n')

if __name__=='__main__':unittest.main()
