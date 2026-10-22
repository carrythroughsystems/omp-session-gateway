"""Portable standard-library tests; no pywinrm, credentials, or network required."""
import base64
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class Transport:
    frames = []
    arguments = []
    options = {}
    response = (b'{"ready":true}', b'', 0)
    closed = False

    def __init__(self, **options):
        type(self).options = options

    def open_shell(self):
        return 'synthetic-shell'

    def run_command(self, *arguments, **options):
        type(self).arguments = arguments
        return 'synthetic-command'

    def send_command_input(self, _shell, _command, data, end=False):
        type(self).frames.append((data, end))

    def get_command_output(self, *_args):
        return type(self).response

    def cleanup_command(self, *_args):
        pass

    def close_shell(self, *_args):
        type(self).closed = True


class WinrmFramingTests(unittest.TestCase):
    def setUp(self):
        Transport.frames = []
        Transport.arguments = []
        Transport.options = {}
        Transport.response = (b'{"ready":true}', b'', 0)
        Transport.closed = False
        module = types.ModuleType('winrm.protocol')
        module.Protocol = Transport
        with patch.dict(sys.modules, {'winrm.protocol': module}):
            self.adapter = runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')))

    def run_request(self, **payload):
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': 'synthetic-transport-only', **payload}
        output = io.StringIO()
        self.stderr = io.StringIO()
        with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(self.stderr):
            self.adapter['main']()
        return json.loads(output.getvalue())

    def test_first_response_marker_precedes_guest_execution_and_has_no_payload(self):
        original = Transport.run_command
        def after_first_response(instance, *args, **options):
            self.assertEqual(self.stderr.getvalue(), 'WINRM_FIRST_RESPONSE 1800000000123\n')
            return original(instance, *args, **options)
        with patch('time.time_ns', return_value=1800000000123000000), \
                patch.object(Transport, 'run_command', after_first_response):
            result = self.run_request(script='synthetic-private-script', observeTransport=True)
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(self.stderr.getvalue(), 'WINRM_FIRST_RESPONSE 1800000000123\n')
        self.assertTrue(Transport.closed)

    def test_missing_authenticated_reply_emits_no_first_response_marker(self):
        with patch.object(Transport, 'open_shell', side_effect=ConnectionError('synthetic refusal')):
            with self.assertRaises(ConnectionError):
                self.run_request(script='synthetic', observeTransport=True)
        self.assertEqual(self.stderr.getvalue(), '')

    def test_ordinary_operations_do_not_emit_transport_markers(self):
        self.run_request(script='synthetic')
        self.assertEqual(self.stderr.getvalue(), '')

    def test_script_and_credential_never_enter_remote_arguments(self):
        script = 'param($p) "synthetic command"'
        result = self.run_request(script=script, input={'fixture': 'z' * 40000})
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(Transport.options['transport'], 'ntlm')
        self.assertEqual(Transport.options['message_encryption'], 'always')
        self.assertNotIn('synthetic-transport-only', repr(Transport.arguments))
        self.assertNotIn(script, repr(Transport.arguments))
        self.assertFalse(Transport.frames[0][1])
        self.assertTrue(Transport.frames[-1][1])
        frame = json.loads(b''.join(part for part, _end in Transport.frames))
        self.assertEqual(frame['script'], script)
        self.assertEqual(frame['input'], {'fixture': 'z' * 40000})
        self.assertTrue(Transport.closed)

    def test_standard_account_connects_as_itself_without_its_password_in_arguments(self):
        result = self.run_request(username='ompstd1a2b3c4d', password='synthetic-standard-only', script='synthetic')
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(Transport.options['username'], 'ompstd1a2b3c4d')
        self.assertEqual(Transport.options['message_encryption'], 'always')
        self.assertNotIn('synthetic-standard-only', repr(Transport.arguments))

    def test_unknown_account_malformed_password_or_standard_upload_opens_no_connection(self):
        upload = {'sourcePath': '/synthetic/source.tar', 'destinationPath': 'C:\\omp-winqual-11111111-1111-4111-8111-111111111111\\source.tar'}
        for request in ({'username': 'Guest'}, {'username': 'ompstd1a2b3c4d\nAdministrator'}, {'password': ''},
                        {'password': 'synthetic\nsecond-line'}, {'username': 'ompstd1a2b3c4d', 'upload': upload}):
            with self.subTest(request=sorted(request)), self.assertRaises(ValueError):
                self.run_request(script='synthetic', **request)
            self.assertEqual(Transport.options, {})

    def test_binary_upload_is_bounded_and_has_exact_eof(self):
        content = bytes(range(256)) * 1025
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.tar'
            source.write_bytes(content)
            self.run_request(upload={'sourcePath': str(source), 'destinationPath': 'C:\\omp-winqual-11111111-1111-4111-8111-111111111111\\source.tar'})
        header = json.loads(Transport.frames[0][0])
        self.assertEqual(header['kind'], 'upload')
        self.assertEqual(Transport.frames[-1], (b'', True))
        chunks = Transport.frames[1:-1]
        self.assertEqual([len(base64.b64decode(chunk)) for chunk, _end in chunks], [65536, 65536, 65536, 65536, 256])
        self.assertTrue(all(not end and len(chunk) <= 90000 and chunk.endswith(b'\n') for chunk, end in chunks))
        self.assertEqual(b''.join(base64.b64decode(chunk) for chunk, _end in chunks), content)
        self.assertNotIn(str(source), repr(Transport.arguments))

    def test_empty_upload_closes_without_inventing_file_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.tar'
            source.write_bytes(b'')
            self.run_request(upload={'sourcePath': str(source), 'destinationPath': 'C:\\omp-winqual-11111111-1111-4111-8111-111111111111\\source.tar'})
        self.assertEqual(len(Transport.frames), 2)
        self.assertEqual(Transport.frames[-1], (b'', True))

    def test_oversized_reply_is_rejected_and_shell_closed(self):
        Transport.response = (b'x' * (1024 * 1024 + 1), b'', 0)
        with self.assertRaisesRegex(ValueError, 'response exceeds bound'):
            self.run_request(script='synthetic')
        self.assertTrue(Transport.closed)

    def test_failed_guest_does_not_echo_stdout_or_arbitrary_stderr(self):
        Transport.response = (b'synthetic-private-output', b'synthetic-private-error guest execution failed at line 42: RuntimeException', 1)
        result = self.run_request(script='synthetic')
        self.assertEqual(result, {'exitCode': 1, 'stdout': '', 'diagnostic': 'guest execution failed at line 42: RuntimeException'})

    def test_status_mismatch_forwards_field_names_and_nothing_after_them(self):
        Transport.response = (b'', b'private guest execution failed at line 82: RuntimeException; status mismatch: ready,active synthetic-private-tail', 1)
        result = self.run_request(script='synthetic')
        self.assertEqual(result['diagnostic'], 'guest execution failed at line 82: RuntimeException; status mismatch: ready,active')

    def test_name_resolution_failure_forwards_the_host_name_and_nothing_after_it(self):
        # A bare WebException hid two campaign failures behind a provider resolver that could not
        # resolve pkgs.tailscale.com (2026-10-02); the host name is not private, the tail still is.
        Transport.response = (b'', b'guest execution failed at line 200: RuntimeException; name resolution failed: pkgs.tailscale.com private-tail', 1)
        result = self.run_request(script='synthetic')
        self.assertEqual(result['diagnostic'], 'guest execution failed at line 200: RuntimeException; name resolution failed: pkgs.tailscale.com')

    def test_teardown_failure_after_a_result_still_answers_exactly_once(self):
        # A guest whose WinRM service is still settling can finish the command and then fail
        # the shell teardown. The finished result used to be followed by a second transport-error
        # object, and two JSON documents on stdout failed the lane with a parse error.
        def refuse(*_args):
            raise ConnectionError('synthetic teardown refusal')
        output = io.StringIO()
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': 'synthetic-transport-only', 'script': 'synthetic'}
        module = types.ModuleType('winrm.protocol')
        module.Protocol = Transport
        code = 0
        with patch.object(Transport, 'cleanup_command', refuse), patch.dict(sys.modules, {'winrm.protocol': module}), \
                patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), \
                contextlib.redirect_stdout(output):
            try:
                runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')), run_name='__main__')
            except SystemExit as exited:
                code = exited.code
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {'exitCode': 0, 'stdout': '{"ready":true}', 'diagnostic': ''})
        self.assertEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
