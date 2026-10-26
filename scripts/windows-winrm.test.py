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


class ConnectTimeout(Exception):
    pass


class ReadTimeout(Exception):
    pass


class InvalidCredentialsError(Exception):
    pass


class WinRMTransportError(Exception):
    def __init__(self, code):
        self.code = code


def modules():
    protocol = types.ModuleType('winrm.protocol')
    protocol.Protocol = Transport
    requests = types.ModuleType('requests.exceptions')
    requests.ConnectTimeout, requests.ReadTimeout = ConnectTimeout, ReadTimeout
    exceptions = types.ModuleType('winrm.exceptions')
    exceptions.InvalidCredentialsError, exceptions.WinRMTransportError = InvalidCredentialsError, WinRMTransportError
    return {'winrm.protocol': protocol, 'requests.exceptions': requests, 'winrm.exceptions': exceptions}


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
        with patch.dict(sys.modules, modules()):
            self.adapter = runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')))

    def run_request(self, **payload):
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': 'synthetic-transport-only', **payload}
        output = io.StringIO()
        self.stderr = io.StringIO()
        with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(self.stderr):
            self.adapter['main']()
        return json.loads(output.getvalue())

    def run_entrypoint(self, request, expected_exit=1):
        output = io.StringIO()
        with patch.dict(sys.modules, modules()), \
                patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')), run_name='__main__')
        self.assertEqual(exited.exception.code, expected_exit)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        return json.loads(output.getvalue())

    def test_lookup_error_keeps_safe_message_frames_and_exact_upload_step(self):
        password = 'synthetic-password-42'
        token = 'synthetic-tailnet-token-43'
        account_secret = 'synthetic-account-secret-44'
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': password,
                   'script': 'synthetic-private-script', 'input': {'joinValue': token, 'accountSecret': account_secret}}
        def lookup_failure(*_args):
            secret_local = 'synthetic-local-must-not-appear'
            raise LookupError(f'unknown encoding: synthetic-codec; {password}; {token}; {account_secret}')
        for step in ('existence/hash', 'remove', 'stream'):
            with self.subTest(step=step), patch.object(Transport, 'open_shell', lookup_failure):
                result = self.run_entrypoint({**request, 'uploadStep': step})
            self.assertEqual(result['diagnostic'], 'LookupError')
            detail = result['exception']
            self.assertEqual(detail['type'], 'LookupError')
            self.assertEqual(detail['uploadStep'], step)
            self.assertIn('unknown encoding: synthetic-codec', detail['message'])
            self.assertEqual(detail['message'].count('[REDACTED]'), 3)
            self.assertTrue(any(frame['function'] == 'lookup_failure' for frame in detail['frames']))
            self.assertTrue(any(frame['file'] == 'windows-winrm.py' for frame in detail['frames']))
            for frame in detail['frames']:
                self.assertEqual(set(frame), {'file', 'line', 'function'})
                self.assertIsInstance(frame['line'], int)
                self.assertNotIn('/', frame['file'])
                self.assertNotIn('\\', frame['file'])
            encoded = json.dumps(result)
            for secret in (password, token, account_secret, 'synthetic-local-must-not-appear', 'synthetic-private-script'):
                self.assertNotIn(secret, encoded)

    def test_exception_message_redacts_encoded_secrets_credentials_and_headers_before_bounding(self):
        from urllib.parse import quote
        password = 'synthetic!private"\\value'
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': password, 'script': 'synthetic-private-script'}
        message = ('unknown encoding: synthetic-codec ' + password + ' ' + quote(password, safe='') + ' ' +
                   json.dumps(password)[1:-1] + '\nAuthorization: NTLM synthetic-derived-header\n' +
                   'https://synthetic-user:synthetic-url-secret@example.invalid/path?token=synthetic-url-token\n' +
                   'Cookie: synthetic-cookie-value\n' + 'x' * 10000)
        with patch.object(Transport, 'open_shell', side_effect=LookupError(message)):
            result = self.run_entrypoint(request)
        detail = result['exception']
        self.assertIsNone(detail['uploadStep'])
        self.assertLessEqual(len(detail['message']), 2048)
        self.assertIn('unknown encoding: synthetic-codec', detail['message'])
        encoded = json.dumps(result)
        for secret in (password, quote(password, safe=''), json.dumps(password)[1:-1],
                       'synthetic-derived-header', 'synthetic-url-secret', 'synthetic-url-token', 'synthetic-cookie-value'):
            self.assertNotIn(secret, encoded)

    def test_exception_context_cannot_inject_unknown_upload_steps_or_traceback_paths(self):
        request = {'host': '192.0.2.10', 'username': 'Administrator', 'password': 'synthetic-transport-only',
                   'script': 'synthetic', 'uploadStep': 'https://private:secret@example.invalid/upload'}
        with patch.object(Transport, 'open_shell', side_effect=LookupError('synthetic failure')):
            result = self.run_entrypoint(request)
        self.assertIsNone(result['exception']['uploadStep'])
        self.assertNotIn('private:secret', json.dumps(result))

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
        self.assertEqual(result['exitCode'], 1)
        self.assertEqual(result['stdout'], '')
        self.assertEqual(result['diagnostic'], 'guest execution failed at line 42: RuntimeException')
        self.assertEqual(result['failure']['kind'], 'guest')

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
        code = 0
        with patch.object(Transport, 'cleanup_command', refuse), patch.dict(sys.modules, modules()), \
                patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), \
                contextlib.redirect_stdout(output):
            try:
                runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')), run_name='__main__')
            except SystemExit as exited:
                code = exited.code
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])['stdout'], '{"ready":true}')
        self.assertEqual(code, 0)
        self.assertTrue(Transport.closed, 'command cleanup failure must not skip shell closure')

    def test_transport_classification_uses_types_not_message_text(self):
        with patch.object(Transport, 'open_shell', side_effect=ConnectionResetError('synthetic')):
            result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                         'password': 'synthetic-only', 'script': 'synthetic', 'readOnly': True})
        self.assertEqual(result['failure'], {'kind': 'transport', 'stage': 'connection',
                                           'condition': 'connection_reset', 'httpStatus': None,
                                           'disposition': 'not_started'})
        with patch.object(Transport, 'open_shell', side_effect=LookupError('ConnectTimeout HTTP 503')):
            result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                         'password': 'synthetic-only', 'script': 'synthetic', 'readOnly': True})
        self.assertEqual(result['failure']['kind'], 'helper')
        self.assertEqual(result['failure']['condition'], 'helper_failure')

    def test_known_timeout_http_and_authentication_conditions(self):
        for error, condition in ((ConnectTimeout(), 'connection_timeout'), (ReadTimeout(), 'read_timeout'),
                                 (WinRMTransportError(503), 'retryable_http'), (WinRMTransportError(429), 'retryable_http'),
                                 (WinRMTransportError(401), 'authentication'), (InvalidCredentialsError(), 'authentication'),
                                 (WinRMTransportError(400), 'helper_failure')):
            with self.subTest(condition=condition), patch.object(Transport, 'open_shell', side_effect=error):
                result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                             'password': 'synthetic-only', 'script': 'synthetic'})
            self.assertEqual(result['failure']['condition'], condition)

    def test_interrupted_output_attempts_both_teardowns(self):
        with patch.object(Transport, 'get_command_output', side_effect=ConnectionResetError('synthetic')), \
                patch.object(Transport, 'cleanup_command', side_effect=ConnectionResetError('synthetic')):
            result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                         'password': 'synthetic-only', 'script': 'synthetic'})
        self.assertTrue(Transport.closed)
        self.assertEqual(result['failure']['stage'], 'output')
        self.assertEqual(result['failure']['disposition'], 'unknown')
        self.assertEqual(result['teardown'], {'commandAttempted': True, 'commandStopped': False,
                                            'shellAttempted': True, 'shellClosed': True})

    def test_controller_sigterm_keeps_unknown_disposition_and_attempts_both_teardowns(self):
        with patch.object(Transport, 'get_command_output', side_effect=SystemExit(143)):
            result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                         'password': 'synthetic-only', 'script': 'synthetic'}, expected_exit=143)
        self.assertEqual(result['failure']['disposition'], 'unknown')
        self.assertTrue(result['teardown']['commandStopped'])
        self.assertTrue(result['teardown']['shellClosed'])

    def test_output_decoding_failure_is_helper_not_transport(self):
        Transport.response = (b'\xff', b'', 0)
        result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                     'password': 'synthetic-only', 'script': 'synthetic'})
        self.assertEqual(result['failure']['kind'], 'helper')
        self.assertEqual(result['failure']['stage'], 'output')
        self.assertEqual(result['failure']['disposition'], 'confirmed')

    def test_wrapped_socket_reset_uses_exception_structure(self):
        with patch.object(Transport, 'open_shell', side_effect=ConnectionError('synthetic', ConnectionResetError())):
            result = self.run_entrypoint({'host': '192.0.2.10', 'username': 'Administrator',
                                         'password': 'synthetic-only', 'script': 'synthetic'})
        self.assertEqual(result['failure']['condition'], 'connection_reset')


if __name__ == '__main__':
    unittest.main()
