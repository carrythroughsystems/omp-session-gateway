- Retry the Windows qualification lane's WinRM admission and read-only probes after a refused
  connection or an unreachable host while a fresh guest boots, instead of ending the lane as a
  `helper_failed` harness error (#565).
