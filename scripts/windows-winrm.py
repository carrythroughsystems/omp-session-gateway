#!/usr/bin/env python3
"""One stdin JSON request, one bounded JSON response. Never put payloads in argv."""
import base64
import json
import re
import signal
import sys
import time
import traceback
from collections import deque
from urllib.parse import quote

from winrm.protocol import Protocol

# The remote command line is constant. The script and its input travel on the encrypted
# WinRS input stream, not -EncodedCommand, environment variables, or temporary scripts.
BOOTSTRAP = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $frame = [Console]::In.ReadLine() | ConvertFrom-Json
  # Only an administrator can read the listener's configuration. A standard account's shell runs on
  # the same listener, which every Administrator call verifies; the client requires encryption anyway.
  if ([Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1] -eq 'Administrator' -and (Get-Item WSMan:\localhost\Service\AllowUnencrypted).Value -ne 'false') { throw 'unencrypted WinRM enabled' }
  if ($frame.kind -eq 'upload') {
    if ($frame.path -notmatch '^C:\\omp-winqual-[0-9a-f-]{36}\\(candidate|predecessor|source)\.tar$') { throw 'upload destination refused' }
    $file = [IO.File]::Open($frame.path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line.Length -gt 90000) { throw 'upload frame too large' }
        $bytes = [Convert]::FromBase64String($line)
        $file.Write($bytes, 0, $bytes.Length)
      }
    } finally { $file.Dispose() }
    '{"uploaded":true}'
  } else {
    $inputData = $frame.input
    & ([ScriptBlock]::Create($frame.script)) $inputData
  }
} catch {
  $diagnostic = 'guest execution failed at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $_.Exception.GetType().Name
  if ($_.Exception.Message -match '^(native command failed: [A-Za-z0-9_.-]+ exit -?[0-9]+|status mismatch: [A-Za-z]+(,[A-Za-z]+)*|name resolution failed: [A-Za-z0-9.-]+)$') { $diagnostic += '; ' + $_.Exception.Message }
  [Console]::Error.WriteLine($diagnostic)
  exit 1
}
"""


# The two accounts a qualification guest has: the provider's built-in Administrator and the
# standard account the lane creates for its non-elevated install.
ACCOUNT = re.compile(r'Administrator|ompstd[0-9a-f]{8}')
UPLOAD_STEPS = ('existence/hash', 'remove', 'stream')


def exception_detail(error, request):
    """Keep actionable context, never request values, traceback source lines or locals."""
    values = set()
    def collect(value):
        if isinstance(value, str) and value:
            values.update((value, json.dumps(value, ensure_ascii=True)[1:-1],
                           repr(value)[1:-1], quote(value, safe='')))
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
    collect(request)
    secrets = sorted(values, key=len, reverse=True)
    def redact(text):
        for secret in secrets:
            text = text.replace(secret, '[REDACTED]')
        # A dependency may include negotiated credentials not present in the input JSON.
        text = re.sub(r'(?im)\b(?:authorization|proxy-authorization|cookie|set-cookie)\b[^\r\n]*',
                      '[REDACTED_HEADER]', text)
        return re.sub(r'\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+', '[REDACTED_URL]', text)
    def frame_name(value):
        return redact(value) if re.fullmatch(r'[A-Za-z0-9_.<>-]{1,120}', value) else '<unknown>'
    frames = deque(maxlen=16)
    for frame, line in traceback.walk_tb(error.__traceback__):
        filename = frame.f_code.co_filename.replace('\\', '/').rsplit('/', 1)[-1]
        frames.append({'file': frame_name(filename), 'line': line, 'function': frame_name(frame.f_code.co_name)})
    step = request.get('uploadStep') if isinstance(request, dict) else None
    return {'type': type(error).__name__, 'message': redact(str(error))[:2048],
            'frames': list(frames), 'uploadStep': step if step in UPLOAD_STEPS else None}


def credentials(request):
    """The request's account and password, refused before any connection is opened."""
    username = request.get('username')
    password = request.get('password')
    if not isinstance(username, str) or not ACCOUNT.fullmatch(username):
        raise ValueError('invalid WinRM account')
    if not isinstance(password, str) or not 0 < len(password) <= 256 or '\n' in password or '\0' in password:
        raise ValueError('invalid WinRM credential')
    # Staging uploads land in the Administrator's private staging root.
    if request.get('upload') and username != 'Administrator':
        raise ValueError('uploads run as Administrator only')
    return username, password


def main(request=None):
    if request is None:
        request = json.loads(sys.stdin.buffer.read(1024 * 1024))
    username, password = credentials(request)
    protocol = Protocol(
        endpoint='http://' + request['host'] + ':5985/wsman',
        transport='ntlm', username=username, password=password,
        message_encryption='always', read_timeout_sec=60, operation_timeout_sec=45,
    )
    shell = protocol.open_shell()
    command = None
    try:
        if request.get('observeTransport') is True:
            # Fixed metadata only: no host, credential, payload, or diagnostic text.
            print('WINRM_FIRST_RESPONSE ' + str(time.time_ns() // 1_000_000), file=sys.stderr, flush=True)
        command = protocol.run_command(shell, 'powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
            base64.b64encode(BOOTSTRAP.encode('utf-16-le')).decode('ascii'),
        ], console_mode_stdin=False)
        upload = request.get('upload')
        header = {'kind': 'upload', 'path': upload['destinationPath']} if upload else {'kind': 'script', 'script': request['script'], 'input': request.get('input')}
        frame = (json.dumps(header) + '\n').encode('utf-8')
        for offset in range(0, len(frame), 32768):
            end = min(offset + 32768, len(frame))
            protocol.send_command_input(shell, command, frame[offset:end], end=not upload and end == len(frame))
        if upload:
            with open(upload['sourcePath'], 'rb') as source:
                while chunk := source.read(65536):
                    protocol.send_command_input(shell, command, base64.b64encode(chunk) + b'\n')
            protocol.send_command_input(shell, command, b'', end=True)
        stdout, stderr, code = protocol.get_command_output(shell, command)
        if len(stdout) > 1024 * 1024 or len(stderr) > 65536:
            raise ValueError('response exceeds bound')
        # No raw stderr: an external program can include its argv or other private data.
        diagnostic = re.search(rb'guest execution failed at line [0-9]+: [A-Za-z0-9]+(?:; (?:native command failed: [A-Za-z0-9_.-]+ exit -?[0-9]+|status mismatch: [A-Za-z]+(?:,[A-Za-z]+)*|name resolution failed: [A-Za-z0-9.-]+))?', stderr)
        result = {'exitCode': code, 'stdout': stdout.decode('utf-8-sig') if code == 0 else '',
                  'diagnostic': diagnostic.group().decode('ascii') if diagnostic else ''}
    finally:
        # A guest whose WinRM service is still settling can finish the command and then refuse the
        # teardown. The response stays the only line on stdout, and the error that ended the command,
        # if any, is the one reported; the service expires an abandoned shell on its own.
        try:
            if command is not None:
                protocol.cleanup_command(shell, command)
            protocol.close_shell(shell)
        except Exception:
            pass
    print(json.dumps(result))


if __name__ == '__main__':
    # The controller's timeout sends SIGTERM; run the shell teardown instead of
    # leaving a WinRS job (and a partially written, exclusively locked upload) alive.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    request = {}
    try:
        request = json.loads(sys.stdin.buffer.read(1024 * 1024))
        main(request)
    except Exception as error:
        code = getattr(error, 'code', None)
        code_text = ' HTTP ' + str(code) if isinstance(code, int) else ''
        fault = getattr(error, 'wsman_fault_code', None)
        fault_text = ' fault ' + str(fault) if isinstance(fault, int) else ''
        print(json.dumps({'exitCode': -1, 'stdout': '', 'diagnostic': type(error).__name__ + code_text + fault_text,
                          'exception': exception_detail(error, request)}))
        sys.exit(1)
